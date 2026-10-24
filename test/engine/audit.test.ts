import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendAudit, GENESIS, verifyAudit } from "../../src/audit";
import { insertMandate, openDb } from "../../src/db";
import { DEMO_MANDATE } from "../../src/fixtures";
import { approvePayment, denyPayment, denyPending, openPayment, type PaymentDeps } from "../../src/payments";
import { createMockSettler } from "../../src/settle/mock";
import type { Check } from "../../src/types";

const LAGOS = DEMO_MANDATE.allowlist[0]!.address;
const held: Check = { name: "auto_approve", pass: false, severity: "escalate", reason: "over the limit" };
const stop: Check = { name: "allowlist", pass: false, severity: "block", reason: "not listed" };

let db: Database;
let deps: PaymentDeps;
beforeEach(() => {
  db = openDb(":memory:");
  insertMandate(db, DEMO_MANDATE);
  deps = { db, settler: createMockSettler() };
});
const open = (checks: Check[]) => openPayment(deps, DEMO_MANDATE, { amount: 100, recipient: LAGOS, purpose: "x" }, checks, 0);
const rows = () => db.query("SELECT * FROM audit_log ORDER BY id").all() as any[];
const trail = (paymentId: string) => rows().filter((r) => r.payment_id === paymentId).map((r) => {
  const d = JSON.parse(r.data);
  return r.event === "opened" ? `opened ${d.status}` : `${d.from} → ${d.to}`;
});

describe("every status change is logged", () => {
  test("an approved payment: opened, then settled", async () => {
    const p = await open([]);
    expect(trail(p.id)).toEqual(["opened settling", "settling → settled"]);
  });

  test("a blocked payment: opened only", async () => {
    expect(trail((await open([stop])).id)).toEqual(["opened blocked"]);
  });

  test("a held payment approved, another denied, another denied by a revoke", async () => {
    const a = await open([held]), b = await open([held]), c = await open([held]);
    await approvePayment(deps, a.id);
    denyPayment(deps, b.id);
    denyPending(deps, DEMO_MANDATE.id, "Mandate was revoked.");
    expect(trail(a.id)).toEqual(["opened pending_approval", "pending_approval → settling", "settling → settled"]);
    expect(trail(b.id)).toEqual(["opened pending_approval", "pending_approval → denied"]);
    expect(trail(c.id)).toEqual(["opened pending_approval", "pending_approval → denied"]);
    expect(JSON.parse(rows().at(-1).data).reason).toBe("Mandate was revoked.");
  });

  test("a refused move adds nothing", async () => {
    const p = await open([held]);
    denyPayment(deps, p.id);
    const before = rows().length;
    expect(() => denyPayment(deps, p.id)).toThrow();
    expect(rows()).toHaveLength(before);
  });

  test("each row links to the one before it", async () => {
    await open([held]);
    await open([]);
    const r = rows();
    expect(r[0].prev_hash).toBe(GENESIS);
    for (let i = 1; i < r.length; i++) expect(r[i].prev_hash).toBe(r[i - 1].hash);
  });
});

describe("verifyAudit", () => {
  test("an empty log and an untouched log verify", async () => {
    expect(verifyAudit(db)).toEqual({ ok: true, entries: 0 });
    const p = await open([held]);
    await approvePayment(deps, p.id);
    expect(verifyAudit(db)).toEqual({ ok: true, entries: 3 });
  });

  test("editing a row by hand breaks verification at that row", async () => {
    for (let i = 0; i < 3; i++) await open([held]);
    const target = rows()[1];
    db.run("UPDATE audit_log SET data = ? WHERE id = ?", [target.data.replace('"amount":100', '"amount":1'), target.id]);
    expect(verifyAudit(db)).toEqual({ ok: false, entries: 3, brokenAt: target.id });
  });

  test("moving a row to another payment, or deleting a row, is caught too", async () => {
    for (let i = 0; i < 3; i++) await open([held]);
    const [, second, third] = rows();
    db.run("UPDATE audit_log SET payment_id = 'pay_other' WHERE id = ?", [second.id]);
    expect(verifyAudit(db)).toMatchObject({ ok: false, brokenAt: second.id });

    db.run("UPDATE audit_log SET payment_id = ? WHERE id = ?", [second.payment_id, second.id]);
    expect(verifyAudit(db).ok).toBe(true);
    // Deleting a row breaks the link from the row after it.
    db.run("DELETE FROM audit_log WHERE id = ?", [second.id]);
    expect(verifyAudit(db)).toMatchObject({ ok: false, brokenAt: third.id });
  });

  test("appendAudit hashes everything in the row", () => {
    appendAudit(db, "pay_1", "opened", { a: 1 }, new Date("2026-10-24T00:00:00Z"));
    const [r] = rows();
    expect(r).toMatchObject({ payment_id: "pay_1", event: "opened", data: '{"a":1}', prev_hash: GENESIS, created_at: "2026-10-24T00:00:00.000Z" });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
