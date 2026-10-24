// Budget warnings: notices only. They never change a verdict; the monthly cap rule does that.
export const WARN_AT = 0.8;

export type BudgetLevel = "ok" | "warn" | "full";
export interface BudgetNotice { pct: number; level: BudgetLevel; text: string | null }

// pct is rounded down, so 79.9% is not shown as "80%".
export function budgetNotice(spent: number, cap: number): BudgetNotice {
  if (!(cap > 0)) return { pct: 0, level: "ok", text: null };
  const pct = Math.floor((spent / cap) * 100);
  if (spent >= cap) return { pct, level: "full", text: "Monthly budget used up" };
  if (spent >= cap * WARN_AT) return { pct, level: "warn", text: `${pct}% of monthly budget used` };
  return { pct, level: "ok", text: null };
}
