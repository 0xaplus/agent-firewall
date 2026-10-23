import { DEMO_MANDATE } from "./fixtures";
import type {
  Check,
  Core,
  Limits,
  Mandate,
  NewMandate,
  Payment,
  PaymentRequest,
  Stats,
} from "./types";

const rand = (n = 8) => crypto.randomUUID().replaceAll("-", "").slice(0, n);

export function createFakeCore(): Core {
  const mandates = new Map<string, Mandate>();
  const payments = new Map<string, Payment>(); // insertion order = oldest first
  mandates.set(DEMO_MANDATE.id, structuredClone(DEMO_MANDATE));

  const need = (id: string): Mandate => {
    const m = mandates.get(id);
    if (!m) throw new Error(`Mandate ${id} not found`);
    return m;
  };
  const needPayment = (id: string): Payment => {
    const p = payments.get(id);
    if (!p) throw new Error(`Payment ${id} not found`);
    return p;
  };
  const pending = (id: string): Payment => {
    const p = needPayment(id);
    if (p.status !== "pending_approval")
      throw new Error(`Payment ${id} is ${p.status}, not pending approval`);
    return p;
  };
  const spent = (mandateId: string) =>
    [...payments.values()]
      .filter((p) => p.mandateId === mandateId && p.status === "settled")
      .reduce((sum, p) => sum + p.amount, 0);
  const settle = (p: Payment) => {
    p.status = "settled";
    p.reference = `fake_${rand(16)}`;
  };

  return {
    mandateForToken: (token) =>
      [...mandates.values()].find((m) => m.agentToken === token) ?? null,

    async requestPayment(
      mandateId: string,
      req: PaymentRequest,
    ): Promise<Payment> {
      const m = need(mandateId);
      const recipient = m.allowlist.find((r) => r.address === req.recipient);
      const remaining = m.monthlyCap - spent(m.id);
      const injected = /ignore previous/i.test(req.context ?? "");

      const checks: Check[] = [
        {
          name: "currency",
          pass: !req.currency || req.currency === m.currency,
          severity: "block",
          reason: `Request is in ${req.currency}, but this mandate only pays in ${m.currency}.`,
        },
        {
          name: "mandate_active",
          pass: m.status === "active",
          severity: "block",
          reason: "This mandate has been revoked.",
        },
        {
          name: "allowlist",
          pass: !!recipient,
          severity: "block",
          reason: recipient
            ? `${recipient.label} is on the allowlist.`
            : "Recipient is not on the allowlist.",
        },
        {
          name: "hard_max",
          pass: req.amount <= m.hardMax,
          severity: "block",
          reason: `${req.amount} ${m.currency} is above the hard limit of ${m.hardMax}.`,
        },
        {
          name: "monthly_cap",
          pass: req.amount <= remaining,
          severity: "block",
          reason: `${req.amount} ${m.currency} would exceed the monthly cap (${remaining} left).`,
        },
        {
          name: "auto_approve",
          pass: req.amount <= m.autoApproveMax,
          severity: "escalate",
          reason: `${req.amount} ${m.currency} is above the auto-approve limit of ${m.autoApproveMax}.`,
        },
        {
          name: "injection",
          pass: !injected,
          severity: "block",
          reason:
            "The attached context contains instructions aimed at the agent.",
        },
      ];
      // Passing checks keep their reason only when it reads as a reason to proceed.
      for (const c of checks)
        if (c.pass && c.name !== "allowlist") c.reason = "OK.";

      const failed = checks.filter((c) => !c.pass);
      const blocks = failed.filter((c) => c.severity === "block").length;
      const escalations = failed.length - blocks;
      const verdict = blocks
        ? "blocked"
        : escalations
          ? "needs_approval"
          : "approved";

      const p: Payment = {
        ...req,
        id: `pay_${rand()}`,
        currency: m.currency,
        mandateId: m.id,
        verdict,
        status:
          verdict === "blocked"
            ? "blocked"
            : verdict === "needs_approval"
              ? "pending_approval"
              : "settling",
        risk: Math.min(100, blocks * 50 + escalations * 20),
        checks,
        createdAt: new Date().toISOString(),
      };
      if (verdict === "approved") settle(p);
      payments.set(p.id, p);
      return structuredClone(p);
    },

    getPayment: (id) => {
      const p = payments.get(id);
      return p ? structuredClone(p) : null;
    },

    getLimits(mandateId: string): Limits {
      const m = need(mandateId);
      const spentThisMonth = spent(m.id);
      return {
        currency: m.currency,
        monthlyCap: m.monthlyCap,
        spentThisMonth,
        remaining: Math.max(0, m.monthlyCap - spentThisMonth),
        autoApproveMax: m.autoApproveMax,
        hardMax: m.hardMax,
        allowedRecipients: structuredClone(m.allowlist),
      };
    },

    createMandate(input: NewMandate): Mandate {
      const m: Mandate = {
        ...structuredClone(input),
        id: `mdt_${rand()}`,
        agentToken: `agt_${rand(16)}`,
        status: "active",
      };
      mandates.set(m.id, m);
      return structuredClone(m);
    },
    getMandate: (id) => {
      const m = mandates.get(id);
      return m ? structuredClone(m) : null;
    },
    revokeMandate(id: string): Mandate {
      const m = need(id);
      m.status = "revoked";
      return structuredClone(m);
    },

    listPayments: (mandateId) =>
      structuredClone(
        [...payments.values()]
          .filter((p) => !mandateId || p.mandateId === mandateId)
          .reverse(),
      ),

    async approvePayment(id: string): Promise<Payment> {
      const p = pending(id);
      p.status = "settling";
      settle(p);
      return structuredClone(p);
    },
    denyPayment(id: string): Payment {
      const p = pending(id);
      p.status = "denied";
      return structuredClone(p);
    },

    stats(mandateId?: string): Stats {
      const all = [...payments.values()].filter(
        (p) => !mandateId || p.mandateId === mandateId,
      );
      const sum = (ps: Payment[]) => ps.reduce((s, p) => s + p.amount, 0);
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

export const core: Core = createFakeCore();
