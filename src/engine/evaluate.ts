import { historyTo, monthSpend, recentPayments } from "../db";
import { openPayment, type PaymentDeps } from "../payments";
import type { Check, Mandate, Payment, PaymentRequest } from "../types";
import type { IntentInput, IntentResult } from "./intent";
import { riskScore, verdictOf } from "./risk";
import { runRules, WINDOW_MINUTES, type RuleCtx } from "./rules";

export interface EvalDeps extends PaymentDeps {
  intent?: (input: IntentInput) => Promise<IntentResult>; // skipped when absent
}

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

// Rules → intent (only if nothing blocked yet) → payment lifecycle.
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

  return openPayment(deps, mandate, req, checks, riskScore(checks, intentScore));
}
