import type { Mandate } from "./types";

export const DEMO_AGENT_TOKEN = "agt_demo_ada";

// TODO: swap these placeholder addresses for real wallets (0x + 40 hex) before the Payfrom demo.
export const DEMO_MANDATE: Mandate = {
  id: "mdt_ada",
  name: "Ada Imports — ops agent",
  task: "Pay Ada Imports' weekly supplier invoices and shipping labels.",
  currency: "USDC",
  agentToken: DEMO_AGENT_TOKEN,
  autoApproveMax: 200, hardMax: 1000, monthlyCap: 2000,
  allowlist: [
    { address: "0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678", label: "Lagos Textiles Ltd", category: "supplier" },
    { address: "0xb2c3d4e5f6a70819304b5c6d7e8f9a0123456789", label: "Kano Leather Co", category: "supplier" },
    { address: "0xc3d4e5f6a7b8091a415c6d7e8f9a0b1234567890", label: "Shenzhen Parts", category: "supplier" },
    { address: "0xd4e5f6a7b8c9102b526d7e8f9a0b1c2345678901", label: "SwiftShip", category: "shipping" },
  ],
  expiresAt: null,
  status: "active",
};
