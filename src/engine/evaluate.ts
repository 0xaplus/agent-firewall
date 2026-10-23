import type { Database } from "bun:sqlite";
import { getPayment, historyTo, insertPayment, monthSpend, recentPayments, updatePayment } from "../db";
import type { Check, Mandate, Payment, PaymentRequest, Settler } from "../types";
import type { IntentInput, IntentResult } from "./intent";
import { riskScore, verdictOf } from "./risk";
import { runRules, WINDOW_MINUTES, type RuleCtx } from "./rules";

export interface EvalDeps {
  db: Database;
  settler: Settler;
  intent?: (input: IntentInput) => Promise<IntentResult>; // skipped when absent
  now?: () => Date;
}

const newId = () => `pay_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

function ctxFor(deps: EvalDeps, mandate: Mandate, req: PaymentRequest): RuleCtx {
  const now = (deps.now ?? (() => new Date()))();
  return {
    mandate, req, now,
    monthSpend: monthSpend(deps.db, mandate.id, now),
    recent: recentPayments(deps.db, mandate.id, WINDOW_MINUTES, now),
    history: historyTo(deps.db, mandate.id, req.recipient),
  };
}

const blockedBy = (checks: Check[]) => verdictOf(checks) === "blocked";

// Rules → intent (only if nothing blocked yet) → verdict → persist → settle if approved.
export async function evaluate(deps: EvalDeps, mandate: Mandate, req: PaymentRequest): Promise<Payment> {
  let checks = runRules(ctxFor(deps, mandate, req));
  let intentScore: number | null = null;

  if (!blockedBy(checks) && deps.intent) {
    const label = mandate.allowlist.find((r) => r.address === req.recipient)?.label ?? "unknown";
    let intent: IntentResult;
    try {
      intent = await deps.intent({
        task: mandate.task, purpose: req.purpose, recipientLabel: label,
        amount: req.amount, currency: mandate.currency, context: req.context,
      });
    } catch {
      intent = { score: null, checks: [{ name: "intent", pass: false, severity: "escalate", reason: "Intent check unavailable (error); a human should review." }] };
    }
    // The LLM call was async: re-read spend and recent requests so concurrent requests can't both slip under a limit.
    checks = [...runRules(ctxFor(deps, mandate, req)), ...intent.checks];
    intentScore = intent.score;
  }

  const verdict = verdictOf(checks);
  const payment: Payment = {
    ...req,
    id: newId(),
    currency: mandate.currency,
    mandateId: mandate.id,
    verdict,
    status: verdict === "blocked" ? "blocked" : verdict === "needs_approval" ? "pending_approval" : "settling",
    risk: riskScore(checks, intentScore),
    checks,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  insertPayment(deps.db, payment);
  return verdict === "approved" ? settlePayment(deps, payment.id) : payment;
}

const failWith = (deps: EvalDeps, p: Payment, reason: string): Payment => {
  const check: Check = { name: "settlement", pass: false, severity: "info", reason };
  updatePayment(deps.db, p.id, { status: "failed", checks: [...p.checks, check] });
  return getPayment(deps.db, p.id)!;
};

// Payment must already be in `settling`. Settler errors become status `failed` with the reason.
export async function settlePayment(deps: EvalDeps, id: string): Promise<Payment> {
  const p = getPayment(deps.db, id);
  if (!p) throw new Error(`Payment ${id} not found`);
  if (!deps.settler.supports(p.currency)) return failWith(deps, p, `The ${deps.settler.name} settler does not support ${p.currency}.`);
  try {
    const r = await deps.settler.send({ paymentId: p.id, amount: p.amount, currency: p.currency, recipient: p.recipient });
    updatePayment(deps.db, p.id, { status: "settled", reference: r.reference, ...(r.receiptUrl ? { receiptUrl: r.receiptUrl } : {}) });
    return getPayment(deps.db, p.id)!;
  } catch (err) {
    return failWith(deps, p, `Settlement failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
  }
}
