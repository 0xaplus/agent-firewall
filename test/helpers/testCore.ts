import { createCore } from "../../src/core.factory";
import { openDb } from "../../src/db";
import { checkIntent, type IntentLlm } from "../../src/engine/intent";
import { seedDemo } from "../../src/seed";
import { createMockSettler } from "../../src/settle/mock";
import type { Core } from "../../src/types";

// The real Core, wired to in-memory stand-ins: SQLite in memory with the demo mandate, the mock settler.
// No network and no API key. The LLM intent check is off, as in production without OPENROUTER_API_KEY,
// unless a test passes a fake LLM.
export function testCore(opts: { llm?: IntentLlm } = {}): Core {
  const db = openDb(":memory:");
  seedDemo(db);
  const { llm } = opts;
  return createCore({ db, settler: createMockSettler(), intent: llm ? (input) => checkIntent(llm, input, 200) : undefined });
}

// A fake LLM that always gives the same reply, or fails with the given error.
export const llmReplying = (reply: string | Error): IntentLlm => ({
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  },
});
