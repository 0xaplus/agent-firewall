import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { report, runBench, summarize, type Attack, type CaseResult } from "../../bench/run";
import { handleApi } from "../../src/api";
import { createFakeCore } from "../../src/core.fake";
import { DEMO_MANDATE } from "../../src/fixtures";
import { handleMcp } from "../../src/mcp/server";
import type { Core } from "../../src/types";

const attacks = (await Bun.file("bench/attacks.json").json()) as Attack[];

describe("attacks.json", () => {
  test("has 20 well-formed cases with unique ids across the six categories", () => {
    expect(attacks).toHaveLength(20);
    expect(new Set(attacks.map((a) => a.id)).size).toBe(20);
    expect(new Set(attacks.map((a) => a.category))).toEqual(new Set([
      "hidden_instructions", "swapped_address", "lookalike_address", "inflated_amount", "split_payments", "fake_urgency",
    ]));
    for (const a of attacks) {
      expect(a.description.length).toBeGreaterThan(5);
      expect(a.requests.length).toBeGreaterThan(0);
      for (const r of a.requests) {
        expect(r.amount).toBeGreaterThan(0);
        expect(r.recipient.length).toBeGreaterThan(0);
        expect(r.purpose.length).toBeGreaterThan(0);
      }
    }
  });
  test("split cases send many requests, each one under the auto-approve limit", () => {
    for (const a of attacks.filter((x) => x.category === "split_payments")) {
      expect(a.requests.length).toBeGreaterThanOrEqual(5);
      for (const r of a.requests) expect(r.amount).toBeLessThanOrEqual(DEMO_MANDATE.autoApproveMax);
    }
  });
});

describe("runBench against the fake core", () => {
  let core: Core;
  let saved: string | undefined;
  beforeEach(() => { core = createFakeCore(); saved = process.env.ADMIN_TOKEN; process.env.ADMIN_TOKEN = "test"; });
  afterEach(() => { if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved; });

  const route = async (input: any, init?: any): Promise<Response> => {
    const req = new Request(input, init);
    return new URL(req.url).pathname.startsWith("/api") ? handleApi(req, core) : handleMcp(req, core);
  };
  const opts = (over: object = {}) => ({
    attacks, mcpUrl: "http://x/mcp", apiBase: "http://x", adminToken: "test", fetch: route, ...over,
  });

  test("naive pays everything; the firewall stops address, amount and injection attacks", async () => {
    const results = await runBench(opts());
    const s = summarize(results);
    expect(s.total).toBe(20);
    expect(s.naivePaid).toBe(20);
    expect(s.firewalledPaid).toBeLessThan(s.naivePaid);
    const leaked = (cat: string) => results.filter((r) => r.category === cat && r.firewalledSucceeded);
    for (const cat of ["swapped_address", "lookalike_address", "inflated_amount", "fake_urgency"]) expect(leaked(cat)).toEqual([]);
    expect(results.find((r) => r.id === "hidden_instructions-1")!.verdicts).toEqual(["blocked"]);
    expect(results.find((r) => r.id === "inflated_amount-3")!.verdicts).toEqual(["needs_approval"]);
  });

  test("each case runs on its own fresh mandate", async () => {
    await runBench(opts());
    const mandates = new Set(core.listPayments().map((p) => p.mandateId));
    expect(mandates.size).toBe(20);
    expect(mandates.has(DEMO_MANDATE.id)).toBe(false);
  });

  test("without an admin token it falls back to the given agent token", async () => {
    const results = await runBench(opts({ attacks: attacks.slice(0, 2), adminToken: undefined, fallbackToken: "agt_demo_ada" }));
    expect(results).toHaveLength(2);
    expect(new Set(core.listPayments().map((p) => p.mandateId))).toEqual(new Set([DEMO_MANDATE.id]));
  });

  test("a wrong admin token fails loudly", async () => {
    await expect(runBench(opts({ adminToken: "nope" }))).rejects.toThrow(/template mandate/);
  });
});

describe("report", () => {
  const rs: CaseResult[] = [
    { id: "a-1", category: "a", description: "stopped", naivePaid: 100, firewalledPaid: 0, naiveSucceeded: true, firewalledSucceeded: false, verdicts: ["blocked"] },
    { id: "a-2", category: "a", description: "leaked", naivePaid: 50, firewalledPaid: 50, naiveSucceeded: true, firewalledSucceeded: true, verdicts: ["approved", "approved"] },
  ];
  test("summarize counts cases and amounts", () => {
    expect(summarize(rs)).toEqual({ total: 2, naivePaid: 2, firewalledPaid: 1, naiveAmount: 150, firewalledAmount: 50 });
  });
  test("prints the headline and flags leaks", () => {
    const lines: string[] = [];
    report(rs, (s) => lines.push(s));
    const out = lines.join("\n");
    expect(out).toContain("naive paid 2/2, firewalled paid 1/2");
    expect(out).toContain("LEAK  a-2");
    expect(out).toContain("approved×2");
  });
});
