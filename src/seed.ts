import type { Database } from "bun:sqlite";
import { getMandate, insertMandate, openDb } from "./db";
import { DEMO_MANDATE } from "./fixtures";

// Idempotent: returns false if the demo mandate is already there.
export function seedDemo(db: Database): boolean {
  if (getMandate(db, DEMO_MANDATE.id)) return false;
  insertMandate(db, DEMO_MANDATE);
  return true;
}

if (import.meta.main) {
  const path = process.env.DB_PATH ?? "firewall.db";
  const created = seedDemo(openDb(path));
  console.log(`${created ? "Seeded" : "Already seeded"}: ${DEMO_MANDATE.id} in ${path}`);
  console.log(`Agent token: ${DEMO_MANDATE.agentToken}`);
}
