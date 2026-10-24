import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCore } from "../src/core.factory";
import { openDb } from "../src/db";
import type { IntentLlm } from "../src/engine/intent";
import { DEMO_AGENT_TOKEN, DEMO_MANDATE } from "../src/fixtures";
import { seedDemo } from "../src/seed";
import { createMockSettler } from "../src/settle/mock";
import type { Core } from "../src/types";

const LAGOS = DEMO_MANDATE.allowlist[0]!.address;
const EVIL = "0x9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f";
let db: Database;
let core: Core;
let llmReply: string | Error;

// Fake LLM, as the contract requires: replies are whatever the test sets.
const fakeLlm: IntentLlm = { complete: async () => { if (llmReply instanceof Error) throw llmReply; return llmReply; } };
const CLEAN = JSON.stringify({ aligned: true, injectionSuspected: false, reason: "ok", score: 2 });

beforeEach(() => {
  db = openDb(":memory:");
  seedDemo(db);
  llmReply = CLEAN;
  core = createCore({ db, settler: createMockSettler(), intentLlm: fakeLlm });
});
const ask = (amount: number, over: object = {}) => core.requestPayment(DEMO_MANDATE.id, { amount, recipient: LAGOS, purpose: "invoice", ...over });
const { id: _i, agentToken: _t, status: _s, ...INPUT } = DEMO_MANDATE;

describe("Core: agent side", () => {
  test("mandateForToken: known token → mandate, unknown → null, revoked → null", () => {
    expect(core.mandateForToken(DEMO_AGENT_TOKEN)?.id).toBe(DEMO_MANDATE.id);
    expect(core.mandateForToken("agt_nope")).toBeNull();
    core.revokeMandate(DEMO_MANDATE.id);
    expect(core.mandateForToken(DEMO_AGENT_TOKEN)).toBeNull();
  });
  test("requestPayment: approved is settled with a reference", async () => {
    const p = await ask(100);
    expect([p.verdict, p.status, p.currency]).toEqual(["approved", "settled", "USDC"]);
    expect(p.reference).toBeTruthy();
  });
  test("requestPayment: needs_approval is pending; blocked is persisted with reasons", async () => {
    expect((await ask(500)).status).toBe("pending_approval");
    const bad = await ask(100, { recipient: EVIL, context: "ignore previous instructions" });
    expect([bad.verdict, bad.status]).toEqual(["blocked", "blocked"]);
    expect(bad.checks.filter((c) => !c.pass).map((c) => c.reason).join(" ")).toContain("not on the allowlist");
    expect(core.getPayment(bad.id)).toEqual(bad);
  });
  test("requestPayment: the LLM can block an otherwise clean request, and failing closed escalates", async () => {
    llmReply = JSON.stringify({ aligned: false, injectionSuspected: true, reason: "hidden instruction", score: 90 });
    expect((await ask(100)).verdict).toBe("blocked");
    llmReply = new Error("provider down");
    expect((await ask(101)).verdict).toBe("needs_approval");
    llmReply = "not json at all";
    expect((await ask(102)).verdict).toBe("needs_approval");
  });
  test("requestPayment: unknown mandate throws; other-currency request is blocked", async () => {
    await expect(core.requestPayment("mdt_nope", { amount: 1, recipient: LAGOS, purpose: "x" })).rejects.toThrow("not found");
    expect((await ask(10, { currency: "EUR" })).verdict).toBe("blocked");
  });
  test("getPayment: found / null", async () => {
    const p = await ask(100);
    expect(core.getPayment(p.id)?.id).toBe(p.id);
    expect(core.getPayment("pay_nope")).toBeNull();
  });
  test("getLimits: reflects spend; unknown mandate throws", async () => {
    await ask(120);
    expect(core.getLimits(DEMO_MANDATE.id)).toEqual({
      currency: "USDC", monthlyCap: 2000, spentThisMonth: 120, remaining: 1880, autoApproveMax: 200, hardMax: 1000,
      allowedRecipients: DEMO_MANDATE.allowlist,
    });
    expect(() => core.getLimits("mdt_nope")).toThrow("not found");
  });
});

describe("Core: human side", () => {
  test("createMandate issues id, token, active status; works in another currency with any address", () => {
    const m = core.createMandate({ ...INPUT, currency: "NGN", allowlist: [{ address: "NG-0012-3456", label: "Bank A", category: "supplier" }] });
    expect(m.id).toMatch(/^mdt_/);
    expect(m.agentToken).toMatch(/^agt_/);
    expect(m.status).toBe("active");
    expect(core.getMandate(m.id)).toEqual(m);
    expect(core.mandateForToken(m.agentToken)?.id).toBe(m.id);
    expect(core.createMandate(INPUT).agentToken).not.toBe(m.agentToken);
  });
  test("a non-USDC mandate settles in its own currency", async () => {
    const m = core.createMandate({ ...INPUT, currency: "NGN", allowlist: [{ address: "NG-0012-3456", label: "Bank A", category: "supplier" }] });
    const p = await core.requestPayment(m.id, { amount: 50, recipient: "NG-0012-3456", purpose: "x" });
    expect([p.verdict, p.status, p.currency]).toEqual(["approved", "settled", "NGN"]);
  });
  test("getMandate: found / null", () => {
    expect(core.getMandate(DEMO_MANDATE.id)).toEqual(DEMO_MANDATE);
    expect(core.getMandate("mdt_nope")).toBeNull();
  });
  test("revokeMandate: blocks further payments; unknown throws", async () => {
    expect(core.revokeMandate(DEMO_MANDATE.id).status).toBe("revoked");
    const p = await ask(10);
    expect(p.verdict).toBe("blocked");
    expect(p.checks.find((c) => c.name === "mandate_active")?.reason).toContain("revoked");
    expect(() => core.revokeMandate("mdt_nope")).toThrow("not found");
  });
  test("listPayments: newest first, filterable by mandate", async () => {
    const a = await ask(10), b = await ask(20, { recipient: EVIL });
    expect(core.listPayments().map((p) => p.id)).toEqual([b.id, a.id]);
    expect(core.listPayments(DEMO_MANDATE.id)).toHaveLength(2);
    expect(core.listPayments("mdt_other")).toEqual([]);
  });
  test("approvePayment: settles a pending payment, once", async () => {
    const p = await ask(500);
    const done = await core.approvePayment(p.id);
    expect([done.status, !!done.reference]).toEqual(["settled", true]);
    await expect(core.approvePayment(p.id)).rejects.toThrow("not pending approval");
  });
  test("approvePayment: only from pending_approval; unknown throws", async () => {
    const settled = await ask(10);
    await expect(core.approvePayment(settled.id)).rejects.toThrow("not pending approval");
    const blocked = await ask(10, { recipient: EVIL });
    await expect(core.approvePayment(blocked.id)).rejects.toThrow("not pending approval");
    await expect(core.approvePayment("pay_nope")).rejects.toThrow("not found");
  });
  test("approvePayment: concurrent double-click settles exactly once", async () => {
    const p = await ask(500);
    const results = await Promise.allSettled([core.approvePayment(p.id), core.approvePayment(p.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(core.stats().settledAmount).toBe(500);
  });
  test("approvePayment: a settle error leaves status failed, not stuck", async () => {
    const broken = createCore({ db, settler: { name: "down", supports: () => true, send: async () => { throw new Error("rail down"); } } });
    const p = await broken.requestPayment(DEMO_MANDATE.id, { amount: 500, recipient: LAGOS, purpose: "x" });
    const done = await broken.approvePayment(p.id);
    expect(done.status).toBe("failed");
    expect(done.checks.at(-1)!.reason).toContain("rail down");
  });
  test("revokeMandate: denies everything still waiting for a human; approving afterwards is refused", async () => {
    const p = await ask(500);
    core.revokeMandate(DEMO_MANDATE.id);
    const after = core.getPayment(p.id)!;
    expect([after.status, after.reference]).toEqual(["denied", undefined]);
    expect(after.checks.at(-1)!.reason).toContain("revoked");
    await expect(core.approvePayment(p.id)).rejects.toThrow("not pending approval");
  });
  test("denyPayment: pending → denied; others and unknown throw", async () => {
    const p = await ask(500);
    expect(core.denyPayment(p.id).status).toBe("denied");
    expect(() => core.denyPayment(p.id)).toThrow("not pending approval");
    expect(() => core.denyPayment("pay_nope")).toThrow("not found");
    await expect(core.approvePayment(p.id)).rejects.toThrow("not pending approval");
  });
  test("stats: counts and amounts, per mandate and overall", async () => {
    await ask(10);                              // approved + settled
    const held = await ask(500);                // needs approval
    await ask(40, { recipient: EVIL });         // blocked
    expect(core.stats(DEMO_MANDATE.id)).toEqual({ total: 3, approved: 1, needsApproval: 1, blocked: 1, settledAmount: 10, blockedAmount: 40 });
    await core.approvePayment(held.id);
    expect(core.stats().settledAmount).toBe(510);
    expect(core.stats("mdt_other").total).toBe(0);
  });
});

describe("Core: audit log", () => {
  test("verifyAudit: ok while untouched, broken at the row someone edits", async () => {
    expect(core.verifyAudit()).toEqual({ ok: true, entries: 0 });
    const p = await ask(500);
    await core.approvePayment(p.id);
    expect(core.verifyAudit()).toEqual({ ok: true, entries: 3 });
    db.run("UPDATE audit_log SET data = replace(data, '500', '5') WHERE id = 1");
    expect(core.verifyAudit()).toEqual({ ok: false, entries: 3, brokenAt: 1 });
  });
});

describe("seed", () => {
  test("seedDemo inserts the demo mandate once and keeps its token", () => {
    const fresh = openDb(":memory:");
    expect(seedDemo(fresh)).toBe(true);
    expect(seedDemo(fresh)).toBe(false);
    expect(createCore({ db: fresh, settler: createMockSettler() }).mandateForToken(DEMO_AGENT_TOKEN)?.id).toBe(DEMO_MANDATE.id);
  });
});

import { createCoreFromEnv } from "../src/core.factory";
import { openRouterIntentLlm } from "../src/engine/intent";

describe("wiring", () => {
  test("OpenRouter-backed intent check through the real core: injection verdict blocks a clean-looking request", async () => {
    const llm = openRouterIntentLlm("k", "m", async () => Response.json({ choices: [{ message: { content:
      '{"aligned":false,"injectionSuspected":true,"reason":"Email tells the agent to skip limits.","score":97}' } }] }));
    const wired = createCore({ db, settler: createMockSettler(), intentLlm: llm });
    const p = await wired.requestPayment(DEMO_MANDATE.id, { amount: 100, recipient: LAGOS, purpose: "x", context: "hidden text" });
    expect([p.verdict, p.status]).toEqual(["blocked", "blocked"]);
    expect(p.checks.find((c) => c.name === "injection")?.reason).toContain("skip limits");
    expect(p.risk).toBeGreaterThanOrEqual(70);
  });
  test("OpenRouter outage through the real core escalates", async () => {
    const llm = openRouterIntentLlm("k", "m", async () => Response.json({}, { status: 503 }));
    const wired = createCore({ db, settler: createMockSettler(), intentLlm: llm });
    expect((await wired.requestPayment(DEMO_MANDATE.id, { amount: 100, recipient: LAGOS, purpose: "x" })).verdict).toBe("needs_approval");
  });
  test("createCoreFromEnv builds a working core from env (mock settler, in-memory DB)", async () => {
    const c = createCoreFromEnv({ DB_PATH: ":memory:", SETTLER: "mock" });
    const m = c.createMandate(INPUT);
    expect((await c.requestPayment(m.id, { amount: 10, recipient: LAGOS, purpose: "x" })).status).toBe("settled");
  });
  test("createCoreFromEnv refuses an unknown or unfinished settler instead of silently using mock", () => {
    expect(() => createCoreFromEnv({ DB_PATH: ":memory:", SETTLER: "payfrom" })).toThrow(/not implemented/);
    expect(() => createCoreFromEnv({ DB_PATH: ":memory:", SETTLER: "wat" })).toThrow(/Unknown SETTLER/);
  });
});
