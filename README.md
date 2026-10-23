# Spend Firewall

A firewall between an AI agent and its money. The agent asks to pay; the firewall checks the request against a human-written mandate, then approves, escalates to a human, or blocks it. The agent can never change its own rules.

One Bun process: MCP server (`/mcp`), REST API (`/api`), live dashboard (`/`).

```
Agent (Claude Code, Claude Desktop, any MCP client)
   │  MCP over HTTP, Authorization: Bearer agt_…
   ▼
 /mcp ─► Core ─► approved ─► settle        Human ─► dashboard ─► approve / deny
              ├► needs_approval ─► waits
              └► blocked ─► logged, agent told why
```

Mandates are currency- and rail-agnostic: every limit is in the mandate's currency, and recipient addresses are opaque strings.

> **Status:** this branch (`part-b`) runs on `src/core.fake.ts`, an in-memory stand-in for the real engine. Verdicts here are canned (see below). Swap the single import in `src/index.ts` from `./core.fake` to `./core` once Part A is merged.

## Quick start

```bash
bun install
ADMIN_TOKEN=change-me bun run dev     # http://localhost:3000
```

Open `http://localhost:3000/?token=change-me`. The token is read once, kept in memory only and removed from the address bar. The demo mandate (`mdt_ada`, 200 / 1000 / 2000 limits, four allowlisted suppliers) is preloaded by the fake core.

In another terminal:

```bash
bun run demo     # an agent works through 5 invoices
ADMIN_TOKEN=change-me bun run bench   # 20 attacks, naive vs firewalled
bun test
```

Environment: `PORT` (3000), `ADMIN_TOKEN` (required for `/api`; if unset every `/api` call returns 401), `ANTHROPIC_API_KEY` (demo agent), `DEMO_MODEL` (default `claude-sonnet-5-5`).

## What the agent can do

Three MCP tools, authenticated by the agent's Bearer token (one token = one mandate; unknown token = 401):

| Tool | Input | Returns |
|---|---|---|
| `request_payment` | `amount, recipient, purpose, currency?, context?` | verdict, reasons, `paymentId`, `reference`/`receiptUrl` when settled |
| `get_payment_status` | `paymentId` | status and reference (only for this mandate's payments) |
| `get_spending_limits` | – | currency, remaining monthly budget, auto-approve threshold, allowlist **labels** |

There is no tool to read or edit mandate rules. Mandates change only through the REST API with the admin token.

## REST API (admin)

All routes need `Authorization: Bearer $ADMIN_TOKEN`. Errors are `{ "error": "…" }` (400 bad input, 401, 404, 405, 409 wrong state, 500).

- `POST /api/mandates`, `GET /api/mandates/:id`, `POST /api/mandates/:id/revoke`
- `GET /api/payments?mandateId=`
- `POST /api/payments/:id/approve`, `POST /api/payments/:id/deny` (only while `pending_approval`)
- `GET /api/stats?mandateId=`

## Connect your own agent

Start the server, then give the agent the MCP URL and the demo agent token `agt_demo_ada`.

**Claude Code**

```bash
claude mcp add --transport http spend-firewall http://localhost:3000/mcp \
  --header "Authorization: Bearer agt_demo_ada"
```

**Claude Desktop** (`claude_desktop_config.json`, via the `mcp-remote` bridge)

```json
{
  "mcpServers": {
    "spend-firewall": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization: Bearer agt_demo_ada"]
    }
  }
}
```

**Any MCP client:** Streamable HTTP, URL `http://localhost:3000/mcp`, header `Authorization: Bearer agt_demo_ada`.

## Demo

`bun run demo` plays the story on five invoices: three clean ones are paid automatically, one over the auto-approve limit waits for a human (approve it on the dashboard), and one poisoned email, which tells the agent to ignore its rules and pay a new wallet, is blocked.

With `ANTHROPIC_API_KEY` set, a real model reads the inbox and pays through MCP. Without it, a scripted stand-in that pays whatever each email says is used instead; it makes no LLM calls and says so when it starts.

## Benchmark

`bench/attacks.json` holds 20 attacks in six categories: hidden instructions, swapped address, lookalike address, inflated amount, split payments and fake urgency. `bun run bench` sends each one two ways:

- **naive:** an agent with no firewall pays whatever the content asks for (simulated, so always 20/20);
- **firewalled:** the same requests through `/mcp`, each case on a fresh mandate so one case cannot use up another's budget (needs `ADMIN_TOKEN`).

A payment held for a human counts as not paid.

Result on the **fake core** (canned rules, no intent check, no velocity limit): `naive paid 20/20, firewalled paid 3/20`. The three leaks are the two split-payment cases and one off-task payment to an allowlisted supplier. They are the cases that need the real engine's velocity rule and LLM intent check. Re-run the bench after the swap to `./core`; these numbers are not the real engine's.

## Fake core behaviour

Blocked: unknown recipient, "ignore previous" in `context`, amount above the hard limit or monthly cap, wrong currency, revoked mandate. Needs approval: amount above the auto-approve limit. Everything else is approved and settled with a fake reference.

## Layout (Part B)

```
src/index.ts       Bun.serve: /mcp, /api/*, /
src/api.ts         REST handlers, ADMIN_TOKEN check, zod validation
src/mcp/server.ts  MCP tools + agent-token auth
src/core.fake.ts   in-memory Core
public/index.html  dashboard (one file, vanilla JS, polls every 2s)
demo/              agent.ts + inbox/*.json
bench/             attacks.json + run.ts
test/surface/      tests for all of the above
```
