# AGENTS.md — Spend Firewall

Bun + TypeScript. One process. Keep it simple.

Read docs/PLAN.md first, then your part's doc (docs/PART_A.md or docs/PART_B.md).

## Which part are you?
- Branch part-a → Part A (engine & money). Branch part-b → Part B (MCP, dashboard, demo).
- Edit ONLY files your part owns. Ownership is marked [A]/[B]/[shared] in the repo layout (docs/PLAN.md).
- Never edit [shared] files (types.ts, fixtures.ts, package.json, .env.example, AGENTS.md, docs/).
- If a shared file looks wrong or something is missing, STOP and tell the human. Do not fix it yourself.

## Rules
- The only link between parts is the Core interface in src/types.ts.
  Part B never imports from src/engine/ or src/settle/.
- No new dependencies beyond: @modelcontextprotocol/sdk, @anthropic-ai/sdk, zod.
- No frameworks (no Express/Hono/React). Use Bun.serve and bun:sqlite.
- Engine functions are pure where possible; pass dependencies (db, llm client, settler) in.
- The agent-facing MCP server must never expose a way to edit mandates.
- The LLM check may only make a verdict stricter. On error/timeout: needs_approval.
- Default to SETTLER=mock. Never call Payfrom in tests.
- Every function you add gets a test. Run `bun test` before finishing.
- Check.reason is shown to humans: short, specific, plain English.

## Commands
- bun install
- bun run seed        # demo mandate + agent token
- bun run dev         # server on :3000 (/mcp, /api, /)
- bun test
- bun run demo        # demo/agent.ts
- bun run bench       # bench/run.ts

## Done means
The task's "done when" line passes, tests are green, and the commit
message starts with the task ID (e.g. "A3: evaluate + persistence").
