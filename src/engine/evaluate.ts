import { getMandate, historyTo, monthSpend, recentPayments } from "../db";
import { openPayment, type PaymentDeps } from "../payments";
import type { Check, Mandate, Payment, PaymentRequest } from "../types";
import { checkIntent, type IntentLlm } from "./intent";
import { riskScore, verdictOf } from "./risk";
import { runRules, WINDOW_MINUTES, type RuleCtx } from "./rules";

export interface EvalDeps extends PaymentDeps {
  intentLlm?: IntentLlm; // no intent check when absent
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

  if (!blockedBy(checks) && deps.intentLlm) {
    const intent = await checkIntent(deps.intentLlm, mandate, req);
    // The LLM call was async: re-read the mandate (it may have been revoked), spend and recent requests,
    // so a revoke takes effect and concurrent requests can't both slip under a limit.
    mandate = getMandate(deps.db, mandate.id) ?? mandate;
    checks = [...runRules(ctxFor(deps, mandate, req)), ...intent.checks];
    intentScore = intent.score;
  }

  return openPayment(deps, mandate, req, checks, riskScore(checks, intentScore));
}
