import type { Database } from "bun:sqlite";
import { createCore } from "../../src/core.factory";
import { openDb } from "../../src/db";
import type { IntentLlm } from "../../src/engine/intent";
import { seedDemo } from "../../src/seed";
import { createMockSettler } from "../../src/settle/mock";
import type { Core } from "../../src/types";

// The real Core on in-memory SQLite and the mock settler. The intent check is off unless a test passes an LLM.
export function testSetup(opts: { llm?: IntentLlm } = {}): { core: Core; db: Database } {
  const db = openDb(":memory:");
  seedDemo(db);
  return { core: createCore({ db, settler: createMockSettler(), intentLlm: opts.llm }), db };
}

export const testCore = (opts: { llm?: IntentLlm } = {}): Core => testSetup(opts).core;

export const llmReplying = (reply: string | Error): IntentLlm => ({
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  },
});
