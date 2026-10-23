import type { Check, Mandate, Payment, PaymentRequest } from "../types";

export const WINDOW_MINUTES = 10;
export const VELOCITY_MAX = 5;
export const ANOMALY_FACTOR = 5;
export const ANOMALY_MIN_HISTORY = 3;

export interface RuleCtx {
  mandate: Mandate;
  req: PaymentRequest;
  monthSpend: number;      // settled + in-flight this month, mandate currency
  recent: Payment[];       // every request in the last WINDOW_MINUTES, any outcome
  history: number[];       // settled amounts previously paid to this recipient
  now: Date;
}
export type Rule = (ctx: RuleCtx) => Check;

const money = (n: number, cur: string) => `${n} ${cur}`;
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const check = (name: string, pass: boolean, severity: Check["severity"], ok: string, bad: string): Check =>
  ({ name, pass, severity, reason: pass ? ok : bad });
// A payment that could still move money: not blocked, denied or failed.
const live = (p: Payment) => p.verdict !== "blocked" && p.status !== "denied" && p.status !== "failed";

export const amountValid: Rule = ({ req }) =>
  check("amount_valid", Number.isFinite(req.amount) && req.amount > 0, "block",
    "Amount is valid.", "Amount must be a positive number.");

// R0
export const currency: Rule = ({ mandate, req }) =>
  check("currency", !req.currency || req.currency === mandate.currency, "block",
    `Paid in ${mandate.currency}.`, `Request is in ${req.currency} but this mandate pays in ${mandate.currency}.`);

// R1
export const mandateActive: Rule = ({ mandate, now }) => {
  if (mandate.status !== "active") return check("mandate_active", false, "block", "", "Mandate is revoked.");
  if (mandate.expiresAt) {
    const exp = new Date(mandate.expiresAt).getTime();
    if (!(exp > now.getTime())) return check("mandate_active", false, "block", "", `Mandate expired on ${mandate.expiresAt}.`);
  }
  return check("mandate_active", true, "block", "Mandate is active.", "");
};

// R2: addresses are opaque strings, compared exactly.
export const allowlist: Rule = ({ mandate, req }) => {
  const r = mandate.allowlist.find((x) => x.address === req.recipient);
  return check("allowlist", !!r, "block", `${r?.label} is on the allowlist.`,
    `Recipient ${short(req.recipient)} is not on the allowlist.`);
};

// R3
export const hardMax: Rule = ({ mandate, req }) =>
  check("hard_max", req.amount <= mandate.hardMax, "block", "Under the hard limit.",
    `${money(req.amount, mandate.currency)} is above the hard limit of ${money(mandate.hardMax, mandate.currency)}.`);

// R4
export const monthlyCap: Rule = ({ mandate, req, monthSpend }) => {
  const left = Math.max(0, mandate.monthlyCap - monthSpend);
  return check("monthly_cap", monthSpend + req.amount <= mandate.monthlyCap, "block", "Within the monthly cap.",
    `${money(req.amount, mandate.currency)} would exceed the monthly cap (${money(left, mandate.currency)} left of ${money(mandate.monthlyCap, mandate.currency)}).`);
};

// R5
export const autoApprove: Rule = ({ mandate, req }) =>
  check("auto_approve", req.amount <= mandate.autoApproveMax, "escalate", "Under the auto-approve limit.",
    `${money(req.amount, mandate.currency)} is above the auto-approve limit of ${money(mandate.autoApproveMax, mandate.currency)}.`);

// R6: more than VELOCITY_MAX requests in the window, counting blocked ones.
export const velocity: Rule = ({ recent }) =>
  check("velocity", recent.length < VELOCITY_MAX, "escalate", "Request rate is normal.",
    `${recent.length} requests in the last ${WINDOW_MINUTES} minutes (limit ${VELOCITY_MAX}).`);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// R7: needs enough history to know what normal looks like.
export const anomaly: Rule = ({ mandate, req, history }) => {
  if (history.length < ANOMALY_MIN_HISTORY) return check("anomaly", true, "escalate", "Not enough history to compare.", "");
  const med = median(history);
  return check("anomaly", req.amount <= ANOMALY_FACTOR * med, "escalate", "In line with past payments.",
    `${money(req.amount, mandate.currency)} is more than ${ANOMALY_FACTOR}× the usual ${money(med, mandate.currency)} to this recipient.`);
};

// R8
export const duplicate: Rule = ({ req, recent }) =>
  check("duplicate", !recent.some((p) => live(p) && p.recipient === req.recipient && p.amount === req.amount), "escalate",
    "Not a duplicate.", "Same amount to the same recipient was already requested in the last 10 minutes.");

// R9: stops one big payment being split into many that each pass R5.
export const cumulative: Rule = ({ mandate, req, recent }) => {
  const before = recent.filter((p) => live(p) && p.recipient === req.recipient).reduce((s, p) => s + p.amount, 0);
  // Nothing earlier to add up: a single large payment is R5's job, not a split.
  return check("cumulative", before === 0 || before + req.amount <= mandate.autoApproveMax, "escalate", "No split-payment pattern.",
    `${money(before, mandate.currency)} already requested for this recipient in ${WINDOW_MINUTES} minutes; with ${money(req.amount, mandate.currency)} that is above the auto-approve limit of ${money(mandate.autoApproveMax, mandate.currency)}.`);
};

export const RULES: Rule[] = [amountValid, currency, mandateActive, allowlist, hardMax, monthlyCap, autoApprove, velocity, anomaly, duplicate, cumulative];

export const runRules = (ctx: RuleCtx): Check[] => RULES.map((r) => r(ctx));
