import type { Database } from "bun:sqlite";
import { getMandate, getMandateByToken, getPayment, insertMandate, listMandates, listPayments, monthSpend, openDb, setMandateStatus } from "./db";
import { evaluate, type EvalDeps } from "./engine/evaluate";
import { verifyAudit } from "./audit";
import { CoreError } from "./errors";
import { approvePayment, denyPayment, denyPending } from "./payments";
import { DEFAULT_INTENT_MODEL, openRouterIntentLlm } from "./engine/intent";
import { createSettler } from "./settle";
import type { Core, Limits, Mandate, NewMandate, Stats } from "./types";

const hex = (n: number) => crypto.randomUUID().replaceAll("-", "").slice(0, n);

export function createCore(deps: EvalDeps): Core {
  const { db } = deps;
  const needMandate = (id: string): Mandate => {
    const m = getMandate(db, id);
    if (!m) throw new CoreError("not_found", `Mandate ${id} not found`);
    return m;
  };

  return {
    // A revoked mandate's token stops working at once.
    mandateForToken(token) {
      const m = getMandateByToken(db, token);
      return m && m.status === "active" ? m : null;
    },

    async requestPayment(mandateId, req) {
      return evaluate(deps, needMandate(mandateId), req);
    },
    getPayment: (id) => getPayment(db, id),

    getLimits(mandateId): Limits {
      const m = needMandate(mandateId);
      const spent = monthSpend(db, m.id, (deps.now ?? (() => new Date()))());
      return {
        currency: m.currency, monthlyCap: m.monthlyCap, spentThisMonth: spent,
        remaining: Math.max(0, m.monthlyCap - spent), autoApproveMax: m.autoApproveMax, hardMax: m.hardMax,
        allowedRecipients: m.allowlist,
      };
    },

    createMandate(input: NewMandate): Mandate {
      const m: Mandate = { ...input, id: `mdt_${hex(10)}`, agentToken: `agt_${hex(24)}`, status: "active" };
      insertMandate(db, m);
      return m;
    },
    getMandate: (id) => getMandate(db, id),
    listMandates: () => listMandates(db),
    revokeMandate(id) {
      needMandate(id);
      setMandateStatus(db, id, "revoked");
      denyPending(deps, id, "Mandate was revoked before a human decided.");
      return needMandate(id);
    },

    listPayments: (mandateId) => listPayments(db, mandateId),

    verifyAudit: () => verifyAudit(db),
    approvePayment: (id) => approvePayment(deps, id),
    denyPayment: (id) => denyPayment(deps, id),

    stats(mandateId): Stats {
      const all = listPayments(db, mandateId);
      const sum = (xs: typeof all) => xs.reduce((s, p) => s + p.amount, 0);
      return {
        total: all.length,
        approved: all.filter((p) => p.verdict === "approved").length,
        needsApproval: all.filter((p) => p.verdict === "needs_approval").length,
        blocked: all.filter((p) => p.verdict === "blocked").length,
        settledAmount: sum(all.filter((p) => p.status === "settled")),
        blockedAmount: sum(all.filter((p) => p.verdict === "blocked")),
      };
    },
  };
}

// Production wiring from the environment. Intent check runs only when an OpenRouter key is set.
// Also returns the database, for modules beside the Core that keep their own tables (Telegram).
export function openCoreFromEnv(env: Record<string, string | undefined> = process.env): { core: Core; db: Database } {
  const key = env.OPENROUTER_API_KEY;
  if (!key) console.warn("OPENROUTER_API_KEY not set: the LLM intent check is OFF (deterministic rules only).");
  const intentLlm = key ? openRouterIntentLlm(key, env.INTENT_MODEL ?? DEFAULT_INTENT_MODEL) : undefined;
  const db = openDb(env.DB_PATH ?? "firewall.db");
  return { core: createCore({ db, settler: createSettler(env.SETTLER ?? "mock"), intentLlm }), db };
}

export function createCoreFromEnv(env: Record<string, string | undefined> = process.env): Core {
  return openCoreFromEnv(env).core;
}
