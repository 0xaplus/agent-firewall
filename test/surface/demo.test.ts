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

import { DEFAULT_MODEL, openRouterLlm, toOpenAiMessages } from "../../demo/openrouter";

describe("openrouter adapter", () => {
  const tools = [{ name: "request_payment", description: "pay", input_schema: { type: "object", properties: {} } }];

  test("converts Anthropic-style history to OpenAI chat messages", () => {
    const out = toOpenAiMessages("sys", [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "c1", name: "request_payment", input: { amount: 5 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{\"verdict\":\"blocked\"}" }] },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: "hello" });
    expect(out[2]).toMatchObject({ role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "request_payment", arguments: "{\"amount\":5}" } }] });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "{\"verdict\":\"blocked\"}" });
  });

  test("sends model, key and tools to OpenRouter and maps tool calls back", async () => {
    let seen: any;
    const fake = async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return Response.json({ choices: [{ message: { content: "paying", tool_calls: [{ id: "c9", type: "function", function: { name: "request_payment", arguments: "{\"amount\":7}" } }] } }] });
    };
    const res = await openRouterLlm("sk-or-test", undefined, fake).create({ system: "s", tools, messages: [{ role: "user", content: "go" }] });
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen.headers.authorization).toBe("Bearer sk-or-test");
    expect(seen.body.model).toBe(DEFAULT_MODEL);
    expect(seen.body.tools[0]).toEqual({ type: "function", function: { name: "request_payment", description: "pay", parameters: tools[0]!.input_schema } });
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content).toEqual([{ type: "text", text: "paying" }, { type: "tool_use", id: "c9", name: "request_payment", input: { amount: 7 } }]);
  });

  test("plain answer ends the turn; bad tool JSON becomes empty input", async () => {
    const answer = openRouterLlm("k", "m", async () => Response.json({ choices: [{ message: { content: "done" } }] }));
    expect((await answer.create({ system: "s", tools, messages: [] })).stop_reason).toBe("end_turn");
    const bad = openRouterLlm("k", "m", async () => Response.json({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "get_spending_limits", arguments: "{oops" } }] } }] }));
    expect((await bad.create({ system: "s", tools, messages: [] })).content).toEqual([{ type: "tool_use", id: "x", name: "get_spending_limits", input: {} }]);
  });

  test("API errors surface the provider message without the key", async () => {
    const llm = openRouterLlm("sk-secret", "m", async () => Response.json({ error: { message: "No credits" } }, { status: 402 }));
    await expect(llm.create({ system: "s", tools, messages: [] })).rejects.toThrow("OpenRouter 402: No credits");
    const empty = openRouterLlm("sk-secret", "m", async () => Response.json({ choices: [] }));
    await expect(empty.create({ system: "s", tools, messages: [] })).rejects.toThrow(/no message/);
  });
});

describe("agent loop over the OpenRouter adapter", () => {
  test("a scripted OpenRouter server drives real payments through MCP", async () => {
    const inbox = loadInbox();
    let call = 0;
    const fakeOpenRouter = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (call++ === 0) {
        return Response.json({ choices: [{ message: { content: null, tool_calls: inbox.map((m, i) => ({
          id: `c${i}`, type: "function",
          function: { name: "request_payment", arguments: JSON.stringify({ amount: m.amount, recipient: m.payTo, purpose: m.subject, context: m.body }) },
        })) } }] });
      }
      const tools = body.messages.filter((x: any) => x.role === "tool");
      expect(tools).toHaveLength(inbox.length);
      expect(body.tools.map((t: any) => t.function.name).sort()).toEqual(["get_payment_status", "get_spending_limits", "request_payment"]);
      return Response.json({ choices: [{ message: { content: "3 paid, 1 pending, 1 blocked." } }] });
    };
    const { outcomes, summary } = await runAgent(await connect(), openRouterLlm("k", "m", fakeOpenRouter), inbox, quiet);
    expect(outcomes.map((o) => o.verdict)).toEqual(["approved", "approved", "approved", "needs_approval", "blocked"]);
    expect(summary).toBe("3 paid, 1 pending, 1 blocked.");
  });
});
