export type Verdict = "approved" | "needs_approval" | "blocked";
export type PaymentStatus =
  | "pending_approval" | "settling" | "settled"
  | "blocked" | "denied" | "failed";

export interface Recipient { address: string; label: string; category: string }

export interface Mandate {
  id: string;
  name: string;            // "Ada Imports — ops agent"
  task: string;            // what the agent is for, used by intent check
  agentToken: string;      // agt_xxx, sent by the agent as Bearer token
  autoApproveMax: number;  // ≤ this → auto if all checks pass
  hardMax: number;         // > this → always blocked
  monthlyCap: number;
  allowlist: Recipient[];
  expiresAt: string | null;
  status: "active" | "revoked";
}
export type NewMandate = Omit<Mandate, "id" | "agentToken" | "status">;

export interface PaymentRequest {
  amount: number;          // USDC
  recipient: string;       // address
  purpose: string;         // agent's stated reason
  context?: string;        // the content the agent was acting on (email, invoice)
}

export interface Check {
  name: string;
  pass: boolean;
  severity: "block" | "escalate" | "info";
  reason: string;          // human-readable, shown on dashboard
}

export interface Payment extends PaymentRequest {
  id: string;
  mandateId: string;
  verdict: Verdict;
  status: PaymentStatus;
  risk: number;            // 0–100, display only
  checks: Check[];
  txHash?: string;
  explorerUrl?: string;
  createdAt: string;
}

export interface Settler {
  // idempotent on paymentId
  send(p: { paymentId: string; amount: number; recipient: string }):
    Promise<{ txHash: string; explorerUrl: string }>;
}

export interface Limits {
  monthlyCap: number; spentThisMonth: number; remaining: number;
  autoApproveMax: number; hardMax: number;
  allowedRecipients: Recipient[];
}

export interface Stats {
  total: number; approved: number; needsApproval: number; blocked: number;
  settledUsdc: number; blockedUsdc: number;
}

// THE SEAM: Part A implements this (src/core.ts), Part B only calls it.
export interface Core {
  // agent side (MCP)
  mandateForToken(agentToken: string): Mandate | null;
  requestPayment(mandateId: string, req: PaymentRequest): Promise<Payment>; // evaluates, settles if approved
  getPayment(id: string): Payment | null;
  getLimits(mandateId: string): Limits;
  // human side (REST / dashboard)
  createMandate(input: NewMandate): Mandate;
  getMandate(id: string): Mandate | null;
  revokeMandate(id: string): Mandate;
  listPayments(mandateId?: string): Payment[];   // newest first
  approvePayment(id: string): Promise<Payment>;  // only from pending_approval; settles
  denyPayment(id: string): Payment;
  stats(mandateId?: string): Stats;
}
