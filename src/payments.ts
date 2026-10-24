// Payment lifecycle: the only module that changes a payment's status.
import type { Database } from "bun:sqlite";
import { appendAudit } from "./audit";
import { getMandate, getPayment, insertPayment, listPayments, monthSpend, movePayment, type PaymentPatch } from "./db";
import { verdictOf } from "./engine/risk";
import { mandateStopped } from "./engine/rules";
import { CoreError } from "./errors";
import type { Check, Mandate, Payment, PaymentRequest, PaymentStatus, Settler } from "./types";

export interface PaymentDeps {
  db: Database;
  settler: Settler;
  now?: () => Date;
}

// A new payment starts as blocked, pending_approval or settling, depending on its verdict.
export const MOVES: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending_approval: ["settling", "denied"],
  settling: ["settled", "failed"],
  settled: [],
  blocked: [],
  denied: [],
  failed: [],
};

const newId = () => `pay_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const words = (s: PaymentStatus) => s.replaceAll("_", " ");

function need(db: Database, id: string): Payment {
  const p = getPayment(db, id);
  if (!p) throw new CoreError("not_found", `Payment ${id} not found`);
  return p;
}

function needPending(db: Database, id: string): Payment {
  const p = need(db, id);
  if (p.status !== "pending_approval") throw new CoreError("wrong_state", `Payment ${id} is ${words(p.status)}, not pending approval`);
  return p;
}

function move(db: Database, p: Payment, to: PaymentStatus, patch: PaymentPatch = {}): Payment {
  if (!MOVES[p.status].includes(to)) throw new CoreError("wrong_state", `Payment ${p.id} cannot go from ${words(p.status)} to ${words(to)}`);
  // The status change and its audit row commit together, or not at all.
  const moved = db.transaction(() => {
    if (!movePayment(db, p.id, p.status, to, patch)) return false;
    const reason = patch.checks?.at(-1)?.reason;
    appendAudit(db, p.id, "status", { from: p.status, to, ...(reason ? { reason } : {}), ...(patch.reference ? { reference: patch.reference } : {}) });
    return true;
  })();
  // Someone else moved it first (a double-click, a revoke): refuse rather than overwrite.
  if (!moved) throw new CoreError("wrong_state", `Payment ${p.id} is no longer ${words(p.status)}`);
  return getPayment(db, p.id)!;
}

const withCheck = (p: Payment, check: Check): PaymentPatch => ({ checks: [...p.checks, check] });
const denial = (reason: string): Check => ({ name: "mandate_active", pass: false, severity: "block", reason });

async function settle(deps: PaymentDeps, p: Payment): Promise<Payment> {
  const fail = (reason: string) => move(deps.db, p, "failed", withCheck(p, { name: "settlement", pass: false, severity: "info", reason }));
  if (!deps.settler.supports(p.currency)) return fail(`The ${deps.settler.name} settler does not support ${p.currency}.`);
  let sent: { reference: string; receiptUrl?: string };
  try {
    sent = await deps.settler.send({ paymentId: p.id, amount: p.amount, currency: p.currency, recipient: p.recipient });
  } catch (err) {
    return fail(`Settlement failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
  }
  return move(deps.db, p, "settled", { reference: sent.reference, ...(sent.receiptUrl ? { receiptUrl: sent.receiptUrl } : {}) });
}

export async function openPayment(deps: PaymentDeps, mandate: Mandate, req: PaymentRequest, checks: Check[], risk: number): Promise<Payment> {
  const verdict = verdictOf(checks);
  const payment: Payment = {
    ...req,
    id: newId(),
    currency: mandate.currency,
    mandateId: mandate.id,
    verdict,
    status: verdict === "blocked" ? "blocked" : verdict === "needs_approval" ? "pending_approval" : "settling",
    risk,
    checks,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  deps.db.transaction(() => {
    insertPayment(deps.db, payment);
    const { mandateId, amount, currency, recipient, status } = payment;
    appendAudit(deps.db, payment.id, "opened", { mandateId, amount, currency, recipient, verdict, status, risk }, new Date(payment.createdAt));
  })();
  return verdict === "approved" ? settle(deps, payment) : payment;
}

export async function approvePayment(deps: PaymentDeps, id: string): Promise<Payment> {
  const p = needPending(deps.db, id);
  // A held payment can outlive its mandate: it may expire while the payment waits, and a request
  // that passed its checks just before a revoke can land after it. Neither may move money.
  const mandate = getMandate(deps.db, p.mandateId);
  const now = (deps.now ?? (() => new Date()))();
  const stopped = mandate ? mandateStopped(mandate, now) : "Mandate not found.";
  if (stopped || !mandate) return move(deps.db, p, "denied", withCheck(p, denial(`${stopped} It can no longer be approved.`)));
  // Held payments don't count toward month spend, so other approvals may have used up the cap meanwhile.
  const spent = monthSpend(deps.db, mandate.id, now);
  if (spent + p.amount > mandate.monthlyCap) {
    const money = (n: number) => `${n} ${mandate.currency}`;
    const reason = `Approving this would exceed the monthly cap (${money(Math.max(0, mandate.monthlyCap - spent))} left of ${money(mandate.monthlyCap)}). It was not paid.`;
    return move(deps.db, p, "denied", withCheck(p, { name: "monthly_cap", pass: false, severity: "block", reason }));
  }
  return settle(deps, move(deps.db, p, "settling"));
}

export function denyPayment(deps: PaymentDeps, id: string): Payment {
  return move(deps.db, needPending(deps.db, id), "denied");
}

export function denyPending(deps: PaymentDeps, mandateId: string, reason: string): number {
  const held = listPayments(deps.db, mandateId).filter((p) => p.status === "pending_approval");
  for (const p of held) move(deps.db, p, "denied", withCheck(p, denial(reason)));
  return held.length;
}
