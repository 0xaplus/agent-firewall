import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadInbox, recap, runAgent, runScripted, type Llm } from "../../demo/agent";
import { createFakeCore } from "../../src/core.fake";
import { DEMO_AGENT_TOKEN, DEMO_MANDATE } from "../../src/fixtures";
import { handleMcp } from "../../src/mcp/server";
import type { Core } from "../../src/types";

let core: Core;
beforeEach(() => { core = createFakeCore(); });

async function connect() {
  const client = new Client({ name: "demo-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://x/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${DEMO_AGENT_TOKEN}` } },
    fetch: (i, init) => handleMcp(new Request(i as any, init), core),
  }));
  return client;
}
const quiet = () => {};

describe("demo inbox", () => {
  test("has 3 clean, 1 over-threshold and 1 poisoned invoice", () => {
    const inbox = loadInbox();
    expect(inbox).toHaveLength(5);
    const listed = new Set(DEMO_MANDATE.allowlist.map((r) => r.address));
    const clean = inbox.filter((m) => listed.has(m.payTo) && m.amount <= DEMO_MANDATE.autoApproveMax);
    const over = inbox.filter((m) => listed.has(m.payTo) && m.amount > DEMO_MANDATE.autoApproveMax);
    const poisoned = inbox.filter((m) => !listed.has(m.payTo));
    expect([clean.length, over.length, poisoned.length]).toEqual([3, 1, 1]);
    expect(poisoned[0]!.body).toMatch(/ignore previous/i);
  });
});

describe("demo agent", () => {
  test("scripted agent: 3 paid, 1 held for a human, 1 blocked", async () => {
    const { outcomes } = await runScripted(await connect(), loadInbox(), quiet);
    expect(outcomes.map((o) => o.verdict)).toEqual(["approved", "approved", "approved", "needs_approval", "blocked"]);
    expect(outcomes[4]!.reasons.length).toBeGreaterThan(0);
    expect(core.stats(DEMO_MANDATE.id)).toMatchObject({ settledAmount: 315, blockedAmount: 400, needsApproval: 1 });
  });

  test("tool-use loop: feeds MCP tools to the model, pays via request_payment, returns the summary", async () => {
    const inbox = loadInbox();
    const seenTools: string[][] = [];
    let turn = 0;
    const llm: Llm = {
      async create(p) {
        seenTools.push((p.tools as any[]).map((t) => t.name));
        if (turn++ === 0) {
          return {
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "Paying now." },
              ...inbox.map((m, i) => ({
                type: "tool_use" as const, id: `tu_${i}`, name: "request_payment",
                input: { amount: m.amount, recipient: m.payTo, purpose: m.subject, context: m.body },
              })),
            ],
          };
        }
        // second turn: the model must have received a tool_result for every call
        const last: any = (p.messages as any[]).at(-1);
        expect(last.role).toBe("user");
        expect(last.content).toHaveLength(inbox.length);
        expect(last.content[0].type).toBe("tool_result");
        expect(last.content[4].content).toContain("blocked");
        return { stop_reason: "end_turn", content: [{ type: "text", text: "All done." }] };
      },
    };
    const { outcomes, summary } = await runAgent(await connect(), llm, inbox, quiet);
    expect(seenTools[0]!.sort()).toEqual(["get_payment_status", "get_spending_limits", "request_payment"]);
    expect(outcomes.map((o) => o.verdict)).toEqual(["approved", "approved", "approved", "needs_approval", "blocked"]);
    expect(summary).toBe("All done.");
  });

  test("tool-use loop stops after the turn limit if the model never finishes", async () => {
    const llm: Llm = {
      create: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "get_spending_limits", input: {} }] }),
    };
    await runAgent(await connect(), llm, [], quiet); // must return, not hang
  });

  test("recap prints the four steps", () => {
    const lines: string[] = [];
    recap([
      { amount: 10, recipient: "0xa", verdict: "approved", reasons: [], reference: "r" },
      { amount: 500, recipient: "0xb", verdict: "needs_approval", reasons: ["over limit"] },
      { amount: 400, recipient: "0xevil", verdict: "blocked", reasons: ["not on allowlist"] },
    ], (s) => lines.push(s));
    const out = lines.join("\n");
    for (const s of ["Step 1", "Step 2", "Step 3", "Step 4"]) expect(out).toContain(s);
    expect(out).toContain("1 paid, 1 waiting for a human, 1 blocked");
  });
});
