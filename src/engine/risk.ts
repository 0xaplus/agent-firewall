import type { Check, Verdict } from "../types";

// Any block wins, then any escalation, else approved.
export function verdictOf(checks: Check[]): Verdict {
  const failed = checks.filter((c) => !c.pass);
  if (failed.some((c) => c.severity === "block")) return "blocked";
  if (failed.some((c) => c.severity === "escalate")) return "needs_approval";
  return "approved";
}

// Display only: severities decide, never this number.
// 50 per failed block check, 20 per failed escalate check, blended with the intent score (0 safe .. 100 malicious).
export function riskScore(checks: Check[], intentScore: number | null = null): number {
  const failed = checks.filter((c) => !c.pass);
  const rules = failed.filter((c) => c.severity === "block").length * 50 + failed.filter((c) => c.severity === "escalate").length * 20;
  const blended = intentScore == null ? rules : Math.max(rules, (rules + intentScore) / 2);
  return Math.min(100, Math.round(blended));
}
