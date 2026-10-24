# Agent Firewall

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

1. **Sign in.** Open the dashboard with your admin token. On a fresh database it opens on "New mandate"; with one mandate it opens on that mandate, and with two or more (for example after `bun run seed`) on **All agents**.
2. **Create a mandate.** Name, what the agent is for, a currency, an auto-approve limit, a hard limit, a monthly cap, and who may be paid (an address and a label each). Each mandate is one agent with its own budget and rules; you can add as many as you like and switch between them from the header.
   Or describe the rules in plain English ("Naira only, up to ₦50,000 without asking me, never more than ₦300,000, ₦1,000,000 a month, pay Lagos Textiles at 0123456789") and press **Draft rules**: a model fills the form, and notes say what it left empty and why. A recipient is kept only if its address appears in your text, so addresses are never invented; impossible limits (auto-approve above the hard limit, hard limit above the cap) are left for you to set. Nothing is saved until you check the form and press Create. Needs `OPENROUTER_API_KEY`.
3. **Connect an agent.** Right after creating a mandate, the dashboard shows the MCP endpoint and the agent's token as ready-to-paste snippets for Claude Code, Claude Desktop and any other MCP client. "Connect an agent" on the mandate card shows them again.
4. **See all your agents.** With two or more mandates the dashboard opens on **All agents**: one card per agent with its status (active, revoked or expired), this month's spend against its cap (bar plus percentage), what is left, how many payments are waiting for you (tap to jump to them), how many were blocked this month, and the last activity. Totals are shown per currency, never added across currencies. Click a card for that agent's full view. From 80% of an agent's monthly cap its card shows an amber "82% of monthly budget used" badge, and a red "Monthly budget used up" at 100%; with Telegram set up you also get one message per agent per month when it first reaches 80%. These are notices only: the monthly cap rule already blocks payments over the cap.
5. **Let the agent work.** Everything it asks for is approved, held or blocked. The top line shows what has been paid out and what has been stopped.
6. **Decide.** Held payments appear under "Waiting for you" with the reason, and Approve or Deny settles or rejects them. Every request, blocked ones included, is in Activity with the reasons in plain English.
7. **Test without an agent.** "Test the firewall" sends a real request as the agent, with presets for a clean invoice, over the limit, an unknown recipient and a prompt injection.
8. **Revoke.** Two clicks on "Revoke mandate" stop the agent's token at once and deny anything still waiting.

The dashboard cannot edit a mandate's rules once created (the core has no update call); create a new mandate to change them.

## Quick start

```bash
bun install
bun run seed                          # demo mandate + agent token, into firewall.db
ADMIN_TOKEN=change-me bun run dev     # http://localhost:3000
```

Open `http://localhost:3000/?token=change-me`. The token is read once and removed from the address bar. It is kept in `sessionStorage`: a refresh keeps you signed in, closing the tab signs you out, and so does the Sign out button. `bun run seed` creates four example agents (mandates), as a user with several agents would have; all appear under **All agents**. Seeding twice is safe.

| Agent | Id / agent token | Currency | Auto-approve / hard / monthly |
|---|---|---|---|
| Ada Imports — ops agent (the demo and bench use this one) | `mdt_ada` / `agt_demo_ada` | USDC | 200 / 1,000 / 2,000 |
| Lagos procurement agent | `mdt_lagos` / `agt_demo_lagos` | NGN | 50,000 / 300,000 / 1,000,000 |
| Cloud infrastructure agent | `mdt_cloud` / `agt_demo_cloud` | USD | 150 / 800 / 2,500 |
| Research subscriptions agent | `mdt_research` / `agt_demo_research` | USD | 30 / 100 / 300 |

Recipient addresses in the examples are placeholders.

In another terminal:

```bash
bun run demo     # an agent works through 5 invoices
bun run demo:compromised   # same, with an agent that tries to pay the poisoned email
ADMIN_TOKEN=change-me bun run bench   # 20 attacks, naive vs firewalled
bun test
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | server port |
| `ADMIN_TOKEN` | – | the operator's key to `/api`: sees every agent; if unset only Google sign-in works |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | – | turn on **Sign in with Google** (see below) |
| `PUBLIC_URL` | from the request | the site's address, used for Google's redirect, e.g. `https://spend-firewall.onrender.com` |
| `DB_PATH` | `firewall.db` | SQLite file (`:memory:` for throwaway runs) |
| `SETTLER` | `mock` | settlement rail (`mock` today) |
| `OPENROUTER_API_KEY` | – | turns on the LLM intent check, drafting rules from plain English, and the LLM demo agent |
| `INTENT_MODEL` | `anthropic/claude-haiku-5.5` | OpenRouter model for the intent check ($0.10/M in, $0.50/M out; `openai/gpt-4.1-mini` and `google/gemini-2.5-flash` also work but cost more) |
| `TELEGRAM_BOT_TOKEN` | – | turns on Telegram approvals (from @BotFather) |
| `TELEGRAM_CHAT_ID` | – | the chat for agents made with the admin token; signed-in users connect their own chat from the dashboard |
| `TELEGRAM_NOTIFY_BLOCKED` | `1` | `0` stops the info messages for blocked payments |
| `TELEGRAM_NOTIFY_PAID` | `1` | `0` stops the "Paid" messages (with receipts) for payments approved without you |
| `TELEGRAM_BOT_USERNAME` | from Telegram | the bot's @name for Connect Telegram links; looked up with `getMe` when unset |
| `DEMO_MODEL` | `anthropic/claude-haiku-5.5` | OpenRouter model for the demo agent |

## Sign in with Google

Each person signs in with their Google account and sees only their own agents: their mandates, their payments, their approvals. Someone else's agent or payment reads as "not found". The admin token still works beside this, sees every agent, and is what the benchmark and local scripts use.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Add the redirect URI `https://<your-site>/auth/google/callback` (and `http://localhost:3000/auth/google/callback` for local use).
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and `PUBLIC_URL` to the site's address. The dashboard then shows **Sign in with Google**.

Sign-in uses Google's server-side code flow: a random state cookie guards the round trip, the server checks the token's audience, issuer, expiry and verified email, and the browser gets a session cookie the page's scripts can't read (`HttpOnly`, `SameSite=Lax`, `Secure` on https), valid for 30 days. Sessions and link codes are stored only as SHA-256 hashes. Writes on a session also need an `x-sf-csrf` header, which only the dashboard's own page can send. Agents are unchanged: they use their `agt_…` token over MCP, and the token says whose agent it is.

## Approve from Telegram

The owner gets held payments on their phone, in Telegram, and decides them there. The server polls Telegram, so the phone only needs internet: no public URL, no hotspot or WSL networking.

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN=…`.
2. **Signed in with Google:** press **Connect Telegram** on the dashboard. It opens the bot with a one-time code (good for 10 minutes); press **Start** and the bot replies "Connected to you@example.com". That chat now gets your agents' messages, and only it can approve them. Press the button again to disconnect.
3. **With the admin token:** start the server (`bun run dev`) and send `/start` to your bot. It replies with your chat id; put it in `.env` as `TELEGRAM_CHAT_ID=…` and restart. Agents made with the admin token report there.

When a payment is held you get a message naming the agent, the amount, the recipient and why it was held, with **Approve** and **Deny** buttons. Tapping one goes through the same checks as the dashboard (monthly cap, expiry, revoke), and the message is edited to the outcome: approved and settled with its reference, denied, not paid with the reason, or already decided elsewhere (on the dashboard, or by a revoke). Blocked payments, such as the poisoned invoice, arrive as an info message without buttons (`TELEGRAM_NOTIFY_BLOCKED=0` turns these off). Payments approved without you arrive as a "Paid" message with a link to the receipt on the block explorer (`TELEGRAM_NOTIFY_PAID=0` turns these off). When an agent first reaches 80% of its monthly budget in a month, you get one warning message, for example "⚠️ Cloud infrastructure agent has used 82% of its monthly budget (2,050 of 2,500 USD)."

Only the chat that owns a payment's agent can decide it (the user's linked chat, or `TELEGRAM_CHAT_ID` for admin agents); taps from other chats are refused and logged. A chat belongs to one account at a time. Messages are plain text. If Telegram is down or misconfigured, the firewall works exactly as before and the module keeps retrying in the background; nothing is ever approved because of a Telegram failure. Payment details (amounts, supplier names) pass through Telegram's servers.

## Approve from a phone

The server listens on all network interfaces, and at startup it prints the address a phone on the same Wi-Fi or hotspot can open (`On your network: http://192.168.…:3000/`). Open `http://<that address>:3000/?token=<ADMIN_TOKEN>` on the phone. When a payment is waiting, it is the first thing on the page, with large Approve and Deny buttons. A new waiting payment shows a "New" flag, puts the count in the tab title, and beeps once you have tapped the page (browsers only allow sound after a tap).

Running under WSL2: the printed address is on WSL's virtual network, which a phone can't reach. The startup log then explains the two fixes: turn on mirrored networking, or forward the port from Windows with `netsh interface portproxy`, then use the Windows machine's Wi-Fi address.

Anyone on the same network can reach the server, but `/api` still needs the admin token and `/mcp` an agent token.

## Check the claims yourself

```bash
bun install
bun test test/surface/promises.test.ts
```

No API key, no network, no running server. Each test name is one promise this README makes (the agent cannot change its rules, a revoked token is refused, split payments are held, the AI check can only make a verdict stricter, and so on), checked end to end on the real firewall: an MCP client talks to `/mcp` and a human talks to `/api`. The AI intent check is tested with a fake model, so results are the same on every run. `bun test` runs everything.

## Deploy (Render)

The repo has a `Dockerfile` and a `render.yaml` blueprint. In Render: **New + → Blueprint**, pick this repository and branch, and apply. Render builds the image, generates a random `ADMIN_TOKEN` (copy it from the service's **Environment** tab), and asks for the optional `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL`. With Google set up, people sign in at `https://<your-service>.onrender.com/`. Otherwise open `https://<your-service>.onrender.com/?token=<ADMIN_TOKEN>`, and point agents at `https://<your-service>.onrender.com/mcp`.

On Render's free plan the service sleeps after 15 minutes without traffic (the next request takes about a minute to wake it, and Telegram is paused while it sleeps), and the disk is not kept: the database starts empty on every restart, including accounts: after a restart people sign in again, reconnect Telegram and recreate their agents. The deploy adds no demo agents: it opens on **New mandate**, so create your mandate after each restart and give the agent its new token. Open the URL a few minutes before demoing. Use a different Telegram bot from the one on your laptop: two servers polling the same bot fight over its messages.

The example agents from `bun run seed` (`agt_demo_ada` and so on) have tokens published in this repository, so never seed a public deployment, least of all one with `SETTLER=payfrom`.

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

- `GET /api/mandates` (every mandate, newest first, agent tokens left out), `POST /api/mandates`, `GET /api/mandates/:id`, `GET /api/mandates/:id/limits`, `POST /api/mandates/:id/revoke`
- `POST /api/mandates/draft` with `{ text }`: returns `{ draft, notes }` drafted from plain English and creates nothing (503 without `OPENROUTER_API_KEY`)
- `GET /api/payments?mandateId=`
- `POST /api/payments/:id/approve`, `POST /api/payments/:id/deny` (only while `pending_approval`)
- `GET /api/stats?mandateId=`
- `GET /api/audit/verify`: re-computes the audit log's hash chain, `{ ok, entries }` or `{ ok: false, entries, brokenAt }`

## Connect your own agent

Start the server, then give the agent the MCP URL and the demo agent token `agt_demo_ada`.

**Claude Code**

```bash
claude mcp add --transport http agent-firewall http://localhost:3000/mcp \
  --header "Authorization: Bearer agt_demo_ada"
```

**Claude Desktop** (`claude_desktop_config.json`, via the `mcp-remote` bridge)

```json
{
  "mcpServers": {
    "agent-firewall": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization: Bearer agt_demo_ada"]
    }
  }
}
```

**Any MCP client:** Streamable HTTP, URL `http://localhost:3000/mcp`, header `Authorization: Bearer agt_demo_ada`.

## Demo

`bun run demo` plays the story on five invoices: three clean ones are paid automatically, one over the auto-approve limit waits for a human (approve it on the dashboard), and one poisoned email, which tells the agent to ignore its rules and pay a new wallet, is blocked.

Which agent plays:

- **`bun run demo:compromised`** (or `bun run demo -- --compromised`): a compromised agent that tries to pay every email, including the poisoned one, even when `OPENROUTER_API_KEY` is set. It makes no LLM calls of its own; every request really goes through `/mcp`, and the firewall always blocks the poisoned one, with the reasons printed. Use this to show the block on demand.
- **`bun run demo` with `OPENROUTER_API_KEY` set:** a real model reached through OpenRouter reads the inbox and pays through MCP. Current models (tested with `anthropic/claude-haiku-5.5` and `anthropic/claude-sonnet-5.5`) usually spot the poisoned email and refuse to pay it, so step 3 then says: "The model refused this time. The firewall is the guarantee for when it doesn't."
- **`bun run demo` without a key:** the same scripted agent as the compromised mode; it says so when it starts.

Running the demo twice on the same database within 10 minutes holds the repeated invoices for a human (the duplicate rule, R8). For a clean rerun, wait 10 minutes or start the server on a fresh `DB_PATH`.

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

If nothing blocked, one LLM call audits intent (5 s timeout). It treats the invoice or email as untrusted data. It can only make the outcome stricter: injection suspected → block, off-task → escalate, error or timeout or unreadable reply → escalate. With no `OPENROUTER_API_KEY` the intent check is off and a warning is logged at startup. Every request is stored, blocked ones included. Revoking a mandate stops its token and denies any payment still waiting for approval. Approving a held payment checks again that the mandate is still active and unexpired, and that paying it would not take this month's spend over the cap; if any of these fails, the payment is denied with the reason, not paid.

## Audit log

Every payment event is written to an append-only `audit_log` table: one row when a request is judged and stored, and one per status change (approved and settled, denied, denied on revoke, failed), in the same transaction as the change. Each row stores `sha256` of its own fields and the previous row's hash, so editing or deleting a row breaks every hash from that row on. The dashboard shows "Audit log verified" under the totals, re-checked every 2 seconds, and `GET /api/audit/verify` says which row broke.

Limits: the chain shows that rows were changed, not who changed them. Someone with write access to the database could delete the newest rows or rebuild the whole chain; anchoring the latest hash somewhere outside the database would close that, and is not built.

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
src/api.ts             REST handlers, admin token or session, per-user scoping, zod validation
src/auth.ts            Sign in with Google: redirect, callback, session cookie
src/users.ts           accounts, sessions and Telegram link codes (stored hashed)
src/mcp/server.ts      MCP tools + agent-token auth
src/core.ts            the real Core, wired from env
src/core.factory.ts    createCore(deps) / createCoreFromEnv()
src/db.ts              SQLite schema + queries
src/payments.ts        payment lifecycle: every status change (open, settle, approve, deny, deny on revoke)
src/schema.ts          zod schema for a new mandate (REST and drafts)
src/compile.ts         drafts a mandate from plain-English rules (never saves)
src/budget.ts          budget warnings at 80% and 100% of the monthly cap
src/telegram.ts        Telegram approvals: notifications, Approve / Deny buttons, long polling
src/audit.ts           hash-chained audit log: appendAudit, verifyAudit
src/errors.ts          CoreError: not_found / wrong_state, mapped to 404 / 409
src/seed.ts            demo mandate
src/engine/            rules.ts, risk.ts, intent.ts, evaluate.ts
src/settle/            index.ts (factory), mock.ts
public/index.html      dashboard (one file, vanilla JS, polls every 2s)
demo/                  agent.ts, openrouter.ts, inbox/*.json
bench/                 attacks.json + run.ts
test/                  engine/, core.contract.test.ts, surface/ (promises.test.ts = the README's claims)
test/helpers/          testCore(): the real Core on in-memory SQLite + mock settler, no network
```
