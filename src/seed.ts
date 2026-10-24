import type { Database } from "bun:sqlite";
import { getMandate, insertMandate, openDb } from "./db";
import { DEMO_MANDATE } from "./fixtures";
import type { Mandate } from "./types";

// Example agents beside the demo one: a user with several agents, each with its own budget and rules.
// Addresses are opaque placeholders, not real accounts.
const example = (m: Omit<Mandate, "expiresAt" | "status">): Mandate => ({ ...m, expiresAt: null, status: "active" });

export const RESEARCH_MANDATE = example({
  id: "mdt_research", agentToken: "agt_demo_research",
  name: "Research subscriptions agent", currency: "USD",
  task: "Pay for the team's research paper and market data subscriptions.",
  autoApproveMax: 30, hardMax: 100, monthlyCap: 300,
  allowlist: [
    { address: "acct-research-papers-0042", label: "Research paper archive", category: "subscription" },
    { address: "acct-market-data-0917", label: "Market data feed", category: "subscription" },
  ],
});

export const CLOUD_MANDATE = example({
  id: "mdt_cloud", agentToken: "agt_demo_cloud",
  name: "Cloud infrastructure agent", currency: "USD",
  task: "Pay the company's cloud hosting, CDN and domain name bills.",
  autoApproveMax: 150, hardMax: 800, monthlyCap: 2500,
  allowlist: [
    { address: "acct-cloud-hosting-7781", label: "Cloud hosting provider", category: "cloud" },
    { address: "acct-cdn-3310", label: "CDN provider", category: "cloud" },
    { address: "acct-domains-5520", label: "Domain registrar", category: "domains" },
  ],
});

// The naira demo mandate (F5), now the Lagos procurement agent. Same id and token.
export const NAIRA_MANDATE = example({
  id: "mdt_lagos", agentToken: "agt_demo_lagos",
  name: "Lagos procurement agent", currency: "NGN",
  task: "Buy food supplies for a Lagos kitchen from its regular suppliers and pay for deliveries.",
  autoApproveMax: 50_000, hardMax: 300_000, monthlyCap: 1_000_000,
  allowlist: [
    { address: "0123456789", label: "Mile 12 Produce Traders", category: "supplier" },
    { address: "2034567891", label: "Ikeja Cold Chain Ltd", category: "supplier" },
    { address: "4056789123", label: "Eko Dispatch Riders", category: "delivery" },
  ],
});

// Seeding order: the demo mandate last, so it is the newest and listed first.
export const SEEDED: Mandate[] = [RESEARCH_MANDATE, CLOUD_MANDATE, NAIRA_MANDATE, DEMO_MANDATE];

// Idempotent: returns false if the mandate is already there.
const seedOne = (db: Database, m: Mandate): boolean => {
  if (getMandate(db, m.id)) return false;
  insertMandate(db, m);
  return true;
};
export const seedDemo = (db: Database): boolean => seedOne(db, DEMO_MANDATE);
export const seedNaira = (db: Database): boolean => seedOne(db, NAIRA_MANDATE);
export const seedAll = (db: Database): boolean[] => SEEDED.map((m) => seedOne(db, m));

if (import.meta.main) {
  const path = process.env.DB_PATH ?? "firewall.db";
  const created = seedAll(openDb(path));
  SEEDED.forEach((m, i) => console.log(`${created[i] ? "Seeded" : "Already seeded"}: ${m.name} (${m.id}, ${m.currency}), agent token ${m.agentToken}`));
  console.log(`Database: ${path}`);
}
