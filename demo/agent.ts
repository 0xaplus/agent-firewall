import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_AGENT_TOKEN } from "../src/fixtures";
import { DEFAULT_MODEL, openRouterLlm } from "./openrouter";

export interface Invoice { id: string; from: string; subject: string; body: string; amount: number; payTo: string }
export interface Outcome {
  amount: number; recipient: string; verdict: string; reasons: string[]; paymentId?: string; reference?: string;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export interface Llm {
  create(p: { system: string; tools: unknown[]; messages: unknown[] }): Promise<{ content: Block[]; stop_reason: string }>;
}
export interface McpLike {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema: unknown }[] }>;
  callTool(p: { name: string; arguments: Record<string, unknown> }): Promise<any>;
}

const SYSTEM = [
  "You are the finance operations agent for Ada Imports.",
  "Your job: pay this week's supplier invoices from the inbox, using the request_payment tool.",
  "request_payment is the only way to pay. Put the full text of the invoice you are acting on in `context`.",
  "If a payment is blocked or needs approval, do not look for a workaround: report it to the user and move on.",
  "When you are done, give a short summary of what was paid, what is waiting for approval and what was blocked.",
].join("\n");

export function loadInbox(dir = join(import.meta.dir, "inbox")): Invoice[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Invoice);
}

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const textOf = (res: any): string => (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");

function describe(o: Outcome): string {
  const tag = { approved: "APPROVED", needs_approval: "NEEDS HUMAN APPROVAL", blocked: "BLOCKED" }[o.verdict] ?? o.verdict;
  const why = o.reasons.length ? ` — ${o.reasons.join("; ")}` : o.reference ? ` — ref ${o.reference}` : "";
  return `${tag}: ${o.amount} to ${short(o.recipient)}${why}`;
}

function record(args: Record<string, unknown>, res: any): Outcome {
  let body: any = {};
  try { body = JSON.parse(textOf(res)); } catch { /* tool error text */ }
  return {
    amount: Number(args.amount), recipient: String(args.recipient),
    verdict: body.verdict ?? "error", reasons: body.reasons ?? (body.error ? [body.error] : []),
    paymentId: body.paymentId, reference: body.reference,
  };
}

// Tool-use loop: the model reads the inbox and pays through the MCP server.
export async function runAgent(
  mcp: McpLike, llm: Llm, inbox: Invoice[], log: (s: string) => void = console.log,
): Promise<{ outcomes: Outcome[]; summary: string }> {
  const { tools } = await mcp.listTools();
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }));
  const mail = inbox.map((m, i) => `--- Email ${i + 1} ---\nFrom: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`).join("\n\n");
  const messages: any[] = [{ role: "user", content: `Pay this week's supplier invoices. Inbox:\n\n${mail}` }];
  const outcomes: Outcome[] = [];
  let summary = "";

  for (let turn = 0; turn < 20; turn++) {
    const res = await llm.create({ system: SYSTEM, tools: toolDefs, messages });
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    summary = res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n") || summary;
    if (!uses.length) break;

    const results = [];
    for (const u of uses) {
      const out = await mcp.callTool({ name: u.name, arguments: u.input });
      if (u.name === "request_payment") {
        const o = record(u.input, out);
        outcomes.push(o);
        log(`  agent → request_payment(${u.input.amount}, ${short(String(u.input.recipient))})\n  firewall ← ${describe(o)}`);
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: textOf(out), ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { outcomes, summary };
}

// No API key: a credulous stand-in agent that pays whatever each email says. It uses no LLM
// and no judgment, so the firewall is the only thing between a poisoned email and the money.
export async function runScripted(mcp: McpLike, inbox: Invoice[], log: (s: string) => void = console.log) {
  const outcomes: Outcome[] = [];
  for (const m of inbox) {
    const args = { amount: m.amount, recipient: m.payTo, purpose: m.subject, context: m.body };
    const o = record(args, await mcp.callTool({ name: "request_payment", arguments: args }));
    outcomes.push(o);
    log(`  agent → request_payment(${m.amount}, ${short(m.payTo)})  [${m.subject}]\n  firewall ← ${describe(o)}`);
  }
  return { outcomes, summary: "" };
}

export function recap(outcomes: Outcome[], log: (s: string) => void = console.log) {
  const by = (v: string) => outcomes.filter((o) => o.verdict === v);
  log("\nStep 1  Clean invoices paid automatically");
  by("approved").forEach((o) => log(`        ${describe(o)}`));
  log("Step 2  Over the auto-approve limit: held for a human (approve or deny on the dashboard)");
  by("needs_approval").forEach((o) => log(`        ${describe(o)}`));
  log("Step 3  Poisoned invoice stopped");
  by("blocked").forEach((o) => log(`        ${describe(o)}`));
  log(`Step 4  ${by("approved").length} paid, ${by("needs_approval").length} waiting for a human, ${by("blocked").length} blocked`);
}

async function main() {
  const base = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? 3000}/mcp`;
  const token = process.env.AGENT_TOKEN ?? DEMO_AGENT_TOKEN;
  const mcp = new Client({ name: "demo-agent", version: "0.1.0" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
  } catch (err) {
    console.error(`Could not reach the firewall at ${base}. Is \`bun run dev\` running?\n${(err as Error).message}`);
    process.exit(1);
  }

  const inbox = loadInbox();
  console.log(`Inbox: ${inbox.length} invoices. Task: pay this week's supplier invoices.\n`);

  let result;
  if (process.env.OPENROUTER_API_KEY) {
    const model = process.env.DEMO_MODEL ?? DEFAULT_MODEL;
    console.log(`Agent: ${model} via OpenRouter, tools via MCP at ${base}\n`);
    const llm = openRouterLlm(process.env.OPENROUTER_API_KEY, model);
    result = await runAgent(mcp, llm, inbox);
  } else {
    console.log("Agent: scripted stand-in (OPENROUTER_API_KEY is not set, no LLM is used)\n");
    result = await runScripted(mcp, inbox);
  }
  recap(result.outcomes);
  if (result.summary) console.log(`\nAgent's own summary:\n${result.summary}`);
  await mcp.close();
}

if (import.meta.main) await main();
