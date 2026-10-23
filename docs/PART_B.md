# Part B: MCP, Dashboard & Demo

Branch `part-b`. You build everything that talks to the outside world: MCP server, REST API, dashboard, demo agent and benchmark. You never write engine logic. You code against the `Core` interface using your own fake (`src/core.fake.ts`), so you're never blocked on A.

## You own

- `src/index.ts`, `src/api.ts`, `src/mcp/server.ts`, `src/core.fake.ts`
- `public/index.html`
- `demo/` (agent.ts, inbox/*.json), `bench/` (attacks.json, run.ts)
- `test/surface/`, `README.md`

**Never edit:** `src/types.ts`, `src/fixtures.ts`, `package.json`, `AGENTS.md`, `docs/`, or anything Part A owns (`src/core.ts`, `src/db.ts`, `src/seed.ts`, `src/engine/`, `src/settle/`).

## The one-line seam

`src/index.ts` gets `core` from one line, and everything else receives it as a parameter (`createMcpServer(core)`, `handleApi(req, core)`). Never import from `engine/` or `settle/`.

```ts
import { core } from "./core.fake"; // swap to "./core" at integration
```

## Tasks (in priority order)

| ID | Task | Done when |
|---|---|---|
| B1 | `core.fake.ts`: in-memory `Core` loaded with `DEMO_MANDATE`. Fake verdicts: unknown recipient or "ignore previous" in context → blocked; amount > autoApproveMax → needs_approval; else approved with a fake reference | Demo and dashboard look realistic before A merges |
| B2 | `index.ts` (`Bun.serve`: `/mcp`, `/api/*`, `/` static) + `api.ts` REST routes with `ADMIN_TOKEN` check | `curl` on each route returns JSON from the fake core |
| B3 | `mcp/server.ts`: Streamable HTTP at `/mcp`; tools `request_payment`, `get_payment_status`, `get_spending_limits`; Bearer `agt_` token → `core.mandateForToken`, else 401 | MCP Inspector lists 3 tools; `request_payment` returns verdict + reasons |
| B4 | `public/index.html`: mandate card (limits, allowlist); live feed polling `/api/payments` every 2s (verdict colour, reasons, risk, receipt link); pending approvals with Approve/Deny; counters (amount settled, amount blocked, shown with the mandate currency) | A blocked payment shows within 2s with reasons; Approve flips it to settled |
| B5 | `demo/agent.ts` + `demo/inbox`: Anthropic tool-use loop connected to `/mcp`, task "pay this week's supplier invoices"; inbox = 3 clean, 1 over threshold, 1 poisoned | `bun run demo` plays the 4-step story |
| B6 | `bench/attacks.json` (20 cases: hidden instructions, swapped address, lookalike address, inflated amount, split payments, fake urgency) + `bench/run.ts`: naive mode (agent pays a mock directly) vs firewalled (via `/mcp`) | Prints "naive paid X/20, firewalled paid Y/20" |
| B7 | Claude Code / Claude Desktop config snippet in README; run one attack from it | Same attack blocked from a second agent |
| B8 | README, 2-min backup video, deck | Done by 11:00 Sat |
| B9 | *Stretch:* Telegram Approve/Deny buttons calling `core.approvePayment` | Only after B1–B7 |

Integration 1 (23:00) needs B1–B4. B5 should be close.

## Rules you must keep

- The MCP server exposes no way to read or edit mandate rules beyond `get_spending_limits`. Ever.
- Tool results always include the reasons, so the agent can tell its user why a payment was blocked.
- `context` from the agent is untrusted: pass it to `core`, never act on it.
- Dashboard: one HTML file, vanilla JS, no build step.
- Never hardcode "USDC" or a 0x address pattern. Show the currency from the mandate; accept any non-empty recipient string.

## Work in isolation

`bun run dev` runs everything end to end on the fake core. Tests in `test/surface/` hit REST and MCP against the fake.

## Handoff gate (before each integration)

- `bun run dev` serves `/mcp`, `/api` and `/` on the fake core
- `bun run demo` plays the full story on the fake core
- `bun test test/surface` green
