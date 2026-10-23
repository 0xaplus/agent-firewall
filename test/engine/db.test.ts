import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  getMandate, getMandateByToken, getPayment, historyTo, insertMandate, insertPayment, listPayments,
  monthSpend, openDb, recentPayments, setMandateStatus, movePayment,
} from "../../src/db";
import { DEMO_MANDATE } from "../../src/fixtures";
import type { Payment } from "../../src/types";

let db: Database;
beforeEach(() => { db = openDb(":memory:"); insertMandate(db, DEMO_MANDATE); });

const NOW = new Date("2026-10-15T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
let n = 0;
const pay = (over: Partial<Payment> = {}): Payment => ({
  id: `pay_${++n}`, mandateId: DEMO_MANDATE.id, amount: 100, currency: "USDC", recipient: "0xaaa", purpose: "x",
  verdict: "approved", status: "settled", risk: 10, checks: [], createdAt: ago(1), ...over,
});

describe("mandates", () => {
  test("round-trips a mandate, looks it up by token, changes status", () => {
    expect(getMandate(db, DEMO_MANDATE.id)).toEqual(DEMO_MANDATE);
    expect(getMandateByToken(db, DEMO_MANDATE.agentToken)?.id).toBe(DEMO_MANDATE.id);
    expect(getMandate(db, "nope")).toBeNull();
    expect(getMandateByToken(db, "agt_nope")).toBeNull();
    setMandateStatus(db, DEMO_MANDATE.id, "revoked");
    expect(getMandate(db, DEMO_MANDATE.id)?.status).toBe("revoked");
  });
  test("keeps expiresAt and non-0x recipient addresses as given", () => {
    const m = { ...DEMO_MANDATE, id: "mdt_2", agentToken: "agt_2", currency: "NGN", expiresAt: "2030-01-01T00:00:00Z",
      allowlist: [{ address: "NG12 0001", label: "Bank", category: "supplier", rail: "bank" }] };
    insertMandate(db, m);
    expect(getMandate(db, "mdt_2")).toEqual(m);
  });
});

describe("payments", () => {
  test("round-trips a Payment with and without optional fields", () => {
    const full = pay({ context: "invoice text", reference: "ref1", receiptUrl: "https://x/r", checks: [{ name: "a", pass: false, severity: "block", reason: "no" }] });
    const bare = pay();
    insertPayment(db, full); insertPayment(db, bare);
    expect(getPayment(db, full.id)).toEqual(full);
    expect(getPayment(db, bare.id)).toEqual(bare);
    expect("context" in getPayment(db, bare.id)!).toBe(false);
    expect(getPayment(db, "nope")).toBeNull();
  });
  test("movePayment changes status and patches only the given fields", () => {
    const p = pay({ status: "settling" });
    insertPayment(db, p);
    expect(movePayment(db, p.id, "settling", "settled", { reference: "r", receiptUrl: "u" })).toBe(true);
    expect(getPayment(db, p.id)).toMatchObject({ status: "settled", reference: "r", receiptUrl: "u", amount: 100 });
    const q = pay({ status: "settling" });
    insertPayment(db, q);
    const checks = [{ name: "s", pass: false, severity: "info" as const, reason: "boom" }];
    expect(movePayment(db, q.id, "settling", "failed", { checks })).toBe(true);
    expect(getPayment(db, q.id)).toMatchObject({ status: "failed", checks });
  });
  test("movePayment succeeds once and only from the expected status", () => {
    const p = pay({ status: "pending_approval" });
    insertPayment(db, p);
    expect(movePayment(db, p.id, "pending_approval", "settling")).toBe(true);
    expect(movePayment(db, p.id, "pending_approval", "settling", { reference: "x" })).toBe(false);
    expect(getPayment(db, p.id)).toMatchObject({ status: "settling" });
    expect(getPayment(db, p.id)!.reference).toBeUndefined();
  });
  test("listPayments is newest first and filters by mandate", () => {
    const a = pay({ createdAt: ago(5) }), b = pay({ createdAt: ago(3) }), c = pay({ createdAt: ago(3) });
    insertPayment(db, a); insertPayment(db, b); insertPayment(db, c);
    expect(listPayments(db).map((p) => p.id)).toEqual([c.id, b.id, a.id]); // ties: later insert first
    expect(listPayments(db, "mdt_other")).toEqual([]);
    expect(listPayments(db, DEMO_MANDATE.id)).toHaveLength(3);
  });
});

describe("queries", () => {
  test("monthSpend counts settled and settling this UTC month only", () => {
    insertPayment(db, pay({ amount: 100 }));
    insertPayment(db, pay({ amount: 50, status: "settling" }));
    insertPayment(db, pay({ amount: 999, status: "pending_approval", verdict: "needs_approval" }));
    insertPayment(db, pay({ amount: 999, status: "blocked", verdict: "blocked" }));
    insertPayment(db, pay({ amount: 999, status: "failed" }));
    insertPayment(db, pay({ amount: 999, createdAt: "2026-09-30T23:59:00Z" }));
    expect(monthSpend(db, DEMO_MANDATE.id, NOW)).toBe(150);
    expect(monthSpend(db, "mdt_other", NOW)).toBe(0);
  });
  test("recentPayments returns every outcome inside the window", () => {
    insertPayment(db, pay({ createdAt: ago(2) }));
    insertPayment(db, pay({ createdAt: ago(9), status: "blocked", verdict: "blocked" }));
    insertPayment(db, pay({ createdAt: ago(11) }));
    expect(recentPayments(db, DEMO_MANDATE.id, 10, NOW)).toHaveLength(2);
    expect(recentPayments(db, DEMO_MANDATE.id, 1, NOW)).toHaveLength(0);
  });
  test("historyTo returns settled amounts to that recipient only", () => {
    insertPayment(db, pay({ amount: 10, recipient: "0xaaa" }));
    insertPayment(db, pay({ amount: 20, recipient: "0xaaa" }));
    insertPayment(db, pay({ amount: 30, recipient: "0xbbb" }));
    insertPayment(db, pay({ amount: 40, recipient: "0xaaa", status: "blocked", verdict: "blocked" }));
    expect(historyTo(db, DEMO_MANDATE.id, "0xaaa")).toEqual([10, 20]);
    expect(historyTo(db, DEMO_MANDATE.id, "0xzzz")).toEqual([]);
  });
});
