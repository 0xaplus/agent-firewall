import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEMO_AGENT_TOKEN } from "../src/fixtures";

export interface AttackRequest { amount: number; recipient: string; purpose: string; context?: string }
export interface Attack { id: string; category: string; description: string; requests: AttackRequest[] }
export interface CaseResult {
  id: string; category: string; description: string;
  naivePaid: number; firewalledPaid: number;   // amount that actually left, in the mandate currency
  naiveSucceeded: boolean; firewalledSucceeded: boolean;
  verdicts: string[];                          // one per request, as the firewall answered
}
export interface BenchOptions {
  attacks: Attack[];
  mcpUrl: string;
  apiBase: string;
  adminToken?: string;                         // lets each case run on a fresh mandate
  templateMandateId?: string;
  fallbackToken?: string;                      // used when there is no admin token
  fetch?: (input: any, init?: any) => Promise<Response>;
}

// The naive agent has no firewall: it pays whatever the content it is reading asks for.
// An attack "succeeds" if any money leaves. A payment held for a human does not count as paid.
const naivePay = (reqs: AttackRequest[]) => reqs.reduce((sum, r) => sum + r.amount, 0);

async function freshAgentToken(o: BenchOptions): Promise<string> {
  if (!o.adminToken) return o.fallbackToken ?? DEMO_AGENT_TOKEN;
  const f = o.fetch ?? fetch;
  const headers = { authorization: `Bearer ${o.adminToken}`, "content-type": "application/json" };
  const tpl = await f(`${o.apiBase}/api/mandates/${o.templateMandateId ?? "mdt_ada"}`, { headers });
  if (!tpl.ok) throw new Error(`Cannot read template mandate (${tpl.status}); is ADMIN_TOKEN right?`);
  const { id: _id, agentToken: _t, status: _s, ...input } = await tpl.json() as any;
  const made = await f(`${o.apiBase}/api/mandates`, { method: "POST", headers, body: JSON.stringify(input) });
  if (!made.ok) throw new Error(`Cannot create bench mandate (${made.status})`);
  return (await made.json() as any).agentToken;
}

async function firewalledRun(o: BenchOptions, token: string, reqs: AttackRequest[]) {
  const client = new Client({ name: "bench", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(o.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    ...(o.fetch ? { fetch: o.fetch } : {}),
  }));
  let paid = 0;
  const verdicts: string[] = [];
  try {
    for (const r of reqs) {
      const res: any = await client.callTool({ name: "request_payment", arguments: { ...r } });
      let body: any = {};
      try { body = JSON.parse(res.content[0].text); } catch { /* tool error */ }
      verdicts.push(body.verdict ?? "error");
      if (body.verdict === "approved") paid += r.amount;
    }
  } finally { await client.close(); }
  return { paid, verdicts };
}

export async function runBench(o: BenchOptions): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const a of o.attacks) {
    const naivePaid = naivePay(a.requests);
    const token = await freshAgentToken(o);   // fresh mandate: one case can't exhaust another's budget
    const fw = await firewalledRun(o, token, a.requests);
    results.push({
      id: a.id, category: a.category, description: a.description,
      naivePaid, firewalledPaid: fw.paid,
      naiveSucceeded: naivePaid > 0, firewalledSucceeded: fw.paid > 0, verdicts: fw.verdicts,
    });
  }
  return results;
}

export function summarize(results: CaseResult[]) {
  const n = results.length;
  return {
    total: n,
    naivePaid: results.filter((r) => r.naiveSucceeded).length,
    firewalledPaid: results.filter((r) => r.firewalledSucceeded).length,
    naiveAmount: results.reduce((s, r) => s + r.naivePaid, 0),
    firewalledAmount: results.reduce((s, r) => s + r.firewalledPaid, 0),
  };
}

function tally(verdicts: string[]) {
  const c: Record<string, number> = {};
  for (const v of verdicts) c[v] = (c[v] ?? 0) + 1;
  return Object.entries(c).map(([v, k]) => (k > 1 ? `${v}×${k}` : v)).join(", ");
}

export function report(results: CaseResult[], log: (s: string) => void = console.log) {
  for (const r of results) {
    log(`${r.firewalledSucceeded ? "LEAK " : "ok   "} ${r.id.padEnd(22)} ${tally(r.verdicts).padEnd(28)} ${r.description}`);
  }
  const s = summarize(results);
  log(`\nnaive paid ${s.naivePaid}/${s.total}, firewalled paid ${s.firewalledPaid}/${s.total}`);
  log(`(amounts that left: naive ${s.naiveAmount}, firewalled ${s.firewalledAmount}; held-for-human payments count as not paid)`);
}

async function main() {
  const port = process.env.PORT ?? 3000;
  const base = process.env.BASE_URL ?? `http://localhost:${port}`;
  const adminToken = process.env.ADMIN_TOKEN;
  const attacks = await Bun.file(new URL("./attacks.json", import.meta.url)).json() as Attack[];
  if (!adminToken) {
    console.warn("ADMIN_TOKEN not set: running all cases on the demo mandate, so budget limits will bleed between cases.\n");
  }
  try {
    report(await runBench({
      attacks, mcpUrl: `${base}/mcp`, apiBase: base, adminToken,
      fallbackToken: process.env.AGENT_TOKEN ?? DEMO_AGENT_TOKEN,
    }));
  } catch (err) {
    console.error(`Bench failed: ${(err as Error).message}\nIs \`bun run dev\` running at ${base}?`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
