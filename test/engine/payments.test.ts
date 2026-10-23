import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getPayment, insertMandate, insertPayment, openDb, setMandateStatus } from "../../src/db";
import { CoreError } from "../../src/errors";
import { MOVES, approvePayment, denyPayment, denyPending, openPayment, type PaymentDeps } from "../../src/payments";
import { DEMO_MANDATE } from "../../src/fixtures";
import { createMockSettler } from "../../src/settle/mock";
import type { Check, Payment, PaymentStatus, Settler } from "../../src/types";

const LAGOS = DEMO_MANDATE.allowlist[0]!.address;
const STATUSES: PaymentStatus[] = ["pending_approval", "settling", "settled", "blocked", "denied", "failed"];
const pass: Check = { name: "ok", pass: true, severity: "block", reason: "fine" };
const escalate: Check = { name: "auto_approve", pass: false, severity: "escalate", reason: "over the limit" };
const block: Check = { name: "allowlist", pass: false, severity: "block", reason: "not listed" };

let db: Database;
let deps: PaymentDeps;
let sent: string[];
beforeEach(() => {
  db = openDb(":memory:");
  insertMandate(db, DEMO_MANDATE);
  sent = [];
  const mock = createMockSettler();
  deps = { db, settler: { ...mock, send: (p) => { sent.push(p.paymentId); return mock.send(p); } } };
});

let n = 0;
function stored(status: PaymentStatus, over: Partial<Payment> = {}): Payment {
  const p: Payment = {
    id: `pay_t${n++}`, mandateId: DEMO_MANDATE.id, amount: 500, currency: "USDC", recipient: LAGOS, purpose: "x",
    verdict: status === "blocked" ? "blocked" : "needs_approval", status, risk: 20, checks: [escalate],
    createdAt: new Date().toISOString(), ...over,
  };
  insertPayment(db, p);
  return p;
}
const open = (checks: Check[]) => openPayment(deps, DEMO_MANDATE, { amount: 100, recipient: LAGOS, purpose: "x" }, checks, 0);
const kindOf = async (f: () => unknown) => {
  try { await f(); return "ok"; } catch (e) { return e instanceof CoreError ? e.kind : `other: ${e}`; }
};

describe("the allowed moves", () => {
  test("only a held payment can be decided, and only a settling one can finish", () => {
    expect(MOVES).toEqual({
      pending_approval: ["settling", "denied"],
      settling: ["settled", "failed"],
      settled: [], blocked: [], denied: [], failed: [],
    });
  });

  for (const status of STATUSES) {
    const allowed = status === "pending_approval";
    test(`approve and deny from ${status}: ${allowed ? "allowed" : "refused as wrong_state, nothing changes"}`, async () => {
      const a = stored(status), d = stored(status);
      expect(await kindOf(() => approvePayment(deps, a.id))).toBe(allowed ? "ok" : "wrong_state");
      expect(await kindOf(() => denyPayment(deps, d.id))).toBe(allowed ? "ok" : "wrong_state");
      expect(getPayment(db, a.id)!.status).toBe(allowed ? "settled" : status);
      expect(getPayment(db, d.id)!.status).toBe(allowed ? "denied" : status);
      expect(sent).toEqual(allowed ? [a.id] : []);
    });
  }

  test("an unknown payment is not_found, with the old wording", async () => {
    expect(await kindOf(() => approvePayment(deps, "pay_nope"))).toBe("not_found");
    expect(() => denyPayment(deps, "pay_nope")).toThrow("Payment pay_nope not found");
  });

  test("a payment that is not held says so in plain English", async () => {
    const p = stored("settled");
    await expect(approvePayment(deps, p.id)).rejects.toThrow(`Payment ${p.id} is settled, not pending approval`);
  });
});

describe("opening a payment", () => {
  test("verdict decides the first status: approved settles, escalated waits, blocked stops", async () => {
    const ok = await open([pass]);
    expect([ok.verdict, ok.status, !!ok.reference]).toEqual(["approved", "settled", true]);
    const held = await open([pass, escalate]);
    expect([held.verdict, held.status]).toEqual(["needs_approval", "pending_approval"]);
    const stopped = await open([escalate, block]);
    expect([stopped.verdict, stopped.status]).toEqual(["blocked", "blocked"]);
    expect(sent).toEqual([ok.id]);
    for (const p of [ok, held, stopped]) expect(getPayment(db, p.id)).toEqual(p);
  });

  test("a settler error ends in failed, with the reason added", async () => {
    deps.settler = { name: "down", supports: () => true, send: async () => { throw new Error("rail down"); } };
    const p = await open([pass]);
    expect(p.status).toBe("failed");
    expect(p.checks.at(-1)).toMatchObject({ name: "settlement", severity: "info", pass: false });
    expect(p.checks.at(-1)!.reason).toContain("rail down");
  });

  test("a currency the settler can't pay ends in failed without sending", async () => {
    const picky: Settler = { name: "picky", supports: () => false, send: async () => { throw new Error("must not send"); } };
    deps.settler = picky;
    const p = await open([pass]);
    expect(p.status).toBe("failed");
    expect(p.checks.at(-1)!.reason).toContain("does not support USDC");
  });
});

describe("deciding a held payment", () => {
  test("a double-click approves exactly once", async () => {
    const p = stored("pending_approval");
    const results = await Promise.allSettled([approvePayment(deps, p.id), approvePayment(deps, p.id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as CoreError).kind).toBe("wrong_state");
    expect(sent).toEqual([p.id]);
  });

  test("a held payment on a revoked mandate is denied on approval, never paid", async () => {
    const p = stored("pending_approval");
    setMandateStatus(db, DEMO_MANDATE.id, "revoked");
    const done = await approvePayment(deps, p.id);
    expect([done.status, done.reference]).toEqual(["denied", undefined]);
    expect(done.checks.at(-1)!.reason).toContain("revoked");
    expect(sent).toEqual([]);
  });
});

describe("denyPending", () => {
  test("denies every held payment of one mandate, with the reason, and touches nothing else", () => {
    const other = { ...DEMO_MANDATE, id: "mdt_other", agentToken: "agt_other" };
    insertMandate(db, other);
    const held = [stored("pending_approval"), stored("pending_approval")];
    const settled = stored("settled");
    const elsewhere = stored("pending_approval", { mandateId: other.id });
    expect(denyPending(deps, DEMO_MANDATE.id, "Mandate was revoked.")).toBe(2);
    for (const p of held) {
      const after = getPayment(db, p.id)!;
      expect(after.status).toBe("denied");
      expect(after.checks.at(-1)).toMatchObject({ pass: false, severity: "block", reason: "Mandate was revoked." });
    }
    expect(getPayment(db, settled.id)!.status).toBe("settled");
    expect(getPayment(db, elsewhere.id)!.status).toBe("pending_approval");
  });
});
