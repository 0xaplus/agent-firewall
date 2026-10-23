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

> **Status:** runs on the real engine (SQLite, rules, LLM intent check, mock settlement). Settlement through Payfrom is not built: `SETTLER=payfrom` fails with a clear error.

## The owner's journey

1. **Sign in.** Open the dashboard with your admin token. On a fresh database it opens on "New mandate"; if you ran `bun run seed` it opens on the demo mandate.
2. **Create a mandate.** Name, what the agent is for, a currency, an auto-approve limit, a hard limit, a monthly cap, and who may be paid (an address and a label each). You can add as many mandates as you like and switch between them from the header; the list is remembered in this browser.
3. **Connect an agent.** Right after creating a mandate, the dashboard shows the MCP endpoint and the agent's token as ready-to-paste snippets for Claude Code, Claude Desktop and any other MCP client. "Connect an agent" on the mandate card shows them again.
4. **Let the agent work.** Everything it asks for is approved, held or blocked. The top line shows what has been paid out and what has been stopped.
5. **Decide.** Held payments appear under "Waiting for you" with the reason, and Approve or Deny settles or rejects them. Every request, blocked ones included, is in Activity with the reasons in plain English.
6. **Test without an agent.** "Test the firewall" sends a real request as the agent, with presets for a clean invoice, over the limit, an unknown recipient and a prompt injection.
7. **Revoke.** Two clicks on "Revoke mandate" stop the agent's token at once and deny anything still waiting.

The dashboard cannot edit a mandate's rules once created (the core has no update call); create a new mandate to change them.

## Quick start

```bash
bun install
bun run seed                          # demo mandate + agent token, into firewall.db
ADMIN_TOKEN=change-me bun run dev     # http://localhost:3000
```

Open `http://localhost:3000/?token=change-me`. The token is read once and removed from the address bar. It is kept in `sessionStorage`: a refresh keeps you signed in, closing the tab signs you out, and so does the Sign out button. The seeded demo mandate is `mdt_ada` (200 auto-approve / 1000 hard / 2000 monthly, four allowlisted suppliers), agent token `agt_demo_ada`.

In another terminal:

```bash
bun run demo     # an agent works through 5 invoices
ADMIN_TOKEN=change-me bun run bench   # 20 attacks, naive vs firewalled
bun test
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | server port |
| `ADMIN_TOKEN` | – | required for `/api`; if unset every `/api` call returns 401 |
| `DB_PATH` | `firewall.db` | SQLite file (`:memory:` for throwaway runs) |
| `SETTLER` | `mock` | settlement rail (`mock` today) |
| `OPENROUTER_API_KEY` | – | turns on the LLM intent check and the LLM demo agent |
| `INTENT_MODEL` | `anthropic/claude-haiku-5.5` | OpenRouter model for the intent check ($0.10/M in, $0.50/M out; `openai/gpt-4.1-mini` and `google/gemini-2.5-flash` also work but cost more) |
| `DEMO_MODEL` | `anthropic/claude-haiku-5.5` | OpenRouter model for the demo agent |

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

With `OPENROUTER_API_KEY` set, a real model reached through OpenRouter reads the inbox and pays through MCP. Note that current models (tested with `anthropic/claude-haiku-5.5` and `anthropic/claude-sonnet-5.5`) usually spot the poisoned email and refuse to pay it themselves, so step 3 then shows that no request reached the firewall. The scripted stand-in (unset the key) always sends it, which shows the firewall's block. Without it, a scripted stand-in that pays whatever each email says is used instead; it makes no LLM calls and says so when it starts.

## How a request is judged

Rules, in code order (`src/engine/rules.ts`). A failed **block** rule blocks; a failed **escalate** rule sends the payment to a human.

| Rule | Check | Fails to |
|---|---|---|
| R0 | request currency, if given, equals the mandate currency | block |
| R1 | mandate active and not expired | block |
| R2 | recipient on the allowlist (exact string match) | block |
| R3 | amount ≤ hard limit | block |
| R4 | this month's settled and in-flight spend + amount ≤ monthly cap | block |
| R5 | amount ≤ auto-approve limit | escalate |
| R6 | fewer than 5 requests in the last 10 minutes (blocked ones count) | escalate |
| R7 | amount ≤ 5× the median past payment to this recipient (needs 3+) | escalate |
| R8 | no same-amount, same-recipient request in the last 10 minutes | escalate |
| R9 | requests to one recipient in 10 minutes add up to ≤ auto-approve limit (catches split payments) | escalate |

R9 and the amount sanity check (positive, finite) are additions to the plan's R0–R8.

If nothing blocked, one LLM call audits intent (5 s timeout). It treats the invoice or email as untrusted data. It can only make the outcome stricter: injection suspected → block, off-task → escalate, error or timeout or unreadable reply → escalate. With no `OPENROUTER_API_KEY` the intent check is off and a warning is logged at startup. Every request is stored, blocked ones included. Revoking a mandate stops its token and denies any payment still waiting for approval.

## Benchmark

`bench/attacks.json` holds 20 attacks in six categories: hidden instructions, swapped address, lookalike address, inflated amount, split payments and fake urgency. `bun run bench` sends each one two ways:

- **naive:** an agent with no firewall pays whatever the content asks for (simulated, so always 20/20);
- **firewalled:** the same requests through `/mcp`, each case on a fresh mandate so one case cannot use up another's budget (needs `ADMIN_TOKEN`).

A payment held for a human counts as not paid.

Results on the real engine:

- **LLM check off** (rules only): `naive paid 20/20, firewalled paid 3/20`, with 490 of 12,489 leaving. The leaks are the first payment of each split series (inside the auto-approve limit) and `hidden_instructions-5`, an off-task payment to an allowlisted supplier with no trigger words.
- **LLM check on** (`anthropic/claude-haiku-5.5` via OpenRouter): `naive paid 20/20, firewalled paid 2/20`, with 340 leaving. The LLM blocks `hidden_instructions-5`. The two remaining leaks are the first payment of each split series (190 and 150), which are within the mandate's own limits; every later payment in the series is held.

The LLM is not deterministic, so re-running can differ slightly. When it fails (timeout, empty or unreadable reply) the payment is held for a human, never approved.

## Layout

```
src/index.ts           Bun.serve: /mcp, /api/*, /
src/api.ts             REST handlers, ADMIN_TOKEN check, zod validation
src/mcp/server.ts      MCP tools + agent-token auth
src/core.ts            the real Core, wired from env
src/core.factory.ts    createCore(deps) / createCoreFromEnv()
src/db.ts              SQLite schema + queries
src/seed.ts            demo mandate
src/engine/            rules.ts, risk.ts, intent.ts, evaluate.ts
src/settle/            index.ts (factory), mock.ts
public/index.html      dashboard (one file, vanilla JS, polls every 2s)
demo/                  agent.ts, openrouter.ts, inbox/*.json
bench/                 attacks.json + run.ts
test/                  engine/, core.contract.test.ts, surface/
test/helpers/          testCore(): the real Core on in-memory SQLite + mock settler, no network
```
