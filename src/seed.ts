import type { Database } from "bun:sqlite";
import { getMandate, insertMandate, openDb } from "./db";
import { DEMO_MANDATE } from "./fixtures";
import type { Mandate } from "./types";

// A second demo mandate in naira for a Lagos business. Account numbers are placeholders.
export const NAIRA_MANDATE: Mandate = {
  id: "mdt_lagos",
  name: "Eko Kitchen — ops agent",
  task: "Pay Eko Kitchen's weekly food supplier, gas and delivery invoices.",
  currency: "NGN",
  agentToken: "agt_demo_lagos",
  autoApproveMax: 50_000, hardMax: 300_000, monthlyCap: 1_000_000,
  allowlist: [
    { address: "0123456789", label: "Mile 12 Produce Traders", category: "supplier" },
    { address: "2034567891", label: "Ikeja Cold Chain Ltd", category: "supplier" },
    { address: "3045678912", label: "Yaba Gas Refills", category: "supplier" },
    { address: "4056789123", label: "Eko Dispatch Riders", category: "delivery" },
  ],
  expiresAt: null,
  status: "active",
};

const seedOne = (db: Database, m: Mandate): boolean => {
  if (getMandate(db, m.id)) return false;
  insertMandate(db, m);
  return true;
};

// Idempotent: returns false if the mandate is already there.
export const seedDemo = (db: Database): boolean => seedOne(db, DEMO_MANDATE);
export const seedNaira = (db: Database): boolean => seedOne(db, NAIRA_MANDATE);

if (import.meta.main) {
  const path = process.env.DB_PATH ?? "firewall.db";
  const db = openDb(path);
  for (const [m, created] of [[DEMO_MANDATE, seedDemo(db)], [NAIRA_MANDATE, seedNaira(db)]] as const) {
    console.log(`${created ? "Seeded" : "Already seeded"}: ${m.id} (${m.currency}) in ${path}, agent token ${m.agentToken}`);
  }
}
