# Part A: Engine & Money

Branch `part-a`. You build everything behind the `Core` interface: storage, policy engine, LLM intent check and settlement. Nothing you build serves HTTP or MCP. Your deliverable is `src/core.ts` exporting `core: Core`, proven by a contract test.

## You own

- `src/core.ts`, `src/db.ts`, `src/seed.ts`
- `src/engine/` (rules.ts, intent.ts, risk.ts, evaluate.ts)
- `src/settle/` (index.ts, mock.ts, payfrom.ts)
- `test/engine/`, `test/core.contract.test.ts`

**Never edit:** `src/types.ts`, `src/fixtures.ts`, `package.json`, `AGENTS.md`, `docs/`, or anything Part B owns (`src/index.ts`, `src/api.ts`, `src/mcp/`, `src/core.fake.ts`, `public/`, `demo/`, `bench/`). Need a contract change? Agree with B, change it on `main`, both rebase.

## Tasks (in priority order)

| ID | Task | Done when |
|---|---|---|
| A1 | `db.ts`: `bun:sqlite` schema for mandates and payments (allowlist and checks as JSON columns). Helpers: insert/get/update/list payments, `monthSpend(mandateId)`, `recentPayments(mandateId, minutes)`, `historyTo(mandateId, recipient)` | A test on a temp DB round-trips a `Payment` |
| A2 | `engine/rules.ts`: R0–R8 from docs/PLAN.md as pure functions `(ctx) => Check`, where `ctx = { mandate, req, monthSpend, recent, history, now }` | Each rule has one passing and one failing test |
| A3 | `engine/risk.ts` + `engine/evaluate.ts`: rules → intent (skipped if already blocked) → verdict + risk score | Clean / over-threshold / poisoned requests give approved / needs_approval / blocked |
| A4 | `settle/mock.ts` (supports any currency), `settle/payfrom.ts` (USDC), `settle/index.ts` (factory on `SETTLER` env). Each implements `Settler` incl. `name` and `supports(currency)` | Mock returns a fake reference; Payfrom (USDC) sends a small real transfer; same `paymentId` twice = one transfer |
| A5 | `core.ts`: implement every `Core` method on A1–A4. `seed.ts` inserts `DEMO_MANDATE` from fixtures | `bun run seed` works; `requestPayment` settles approved payments |
| A6 | `test/core.contract.test.ts`: calls every `Core` method with the mock settler and a fake LLM | Green = ready to merge |
| A7 | `engine/intent.ts`: `checkIntent(llm, input) => Check[]`, model `claude-haiku-5-5`, 5s timeout, JSON output, client injected | Fake-LLM tests: aligned → pass, injection → block, timeout/error → escalate |
| A8 | After Integration 2: harden against `bench/attacks.json` | Every attack is blocked or escalated |

Integration 1 (23:00) needs only A1–A6. The LLM check (A7) lands for Integration 2.

## Rules you must keep

- The LLM may only make a verdict stricter. Error or timeout → `needs_approval`.
- Skip the LLM call when deterministic rules already block.
- Persist every request, including blocked ones. The dashboard shows them.
- `approvePayment` works only on `pending_approval`. Settle error → status `failed` with the reason.
- Reasons are short and specific: "Recipient 0xAB…12 is not on the allowlist".

## Work in isolation

You never need B's code. Develop against tests: `bun test test/engine`. For a quick manual run, a scratch script calling `core.requestPayment(DEMO_MANDATE.id, {…})` is enough. Keep `SETTLER=mock` until A4.

## Handoff gate (before each integration)

- `bun test` green, including the contract test
- `bun run seed` works on a fresh DB
- `part-a` pushed; tell B which `Core` methods are real and which still throw `not implemented`
