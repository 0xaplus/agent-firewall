export type Verdict = "approved" | "needs_approval" | "blocked";
export type PaymentStatus =
  | "pending_approval" | "settling" | "settled"
  | "blocked" | "denied" | "failed";

// address = whatever the rail understands: wallet address, account number, IBAN, mobile-money number...
export interface Recipient { address: string; label: string; category: string; rail?: string }

export interface Mandate {
  id: string;
  name: string;            // "Ada Imports — ops agent"
  task: string;            // what the agent is for, used by intent check
  currency: string;        // "USDC", "USD", "NGN"... every limit on this mandate is in this currency
  agentToken: string;      // agt_xxx, sent by the agent as Bearer token
  autoApproveMax: number;  // ≤ this → auto if all checks pass
  hardMax: number;         // > this → always blocked
  monthlyCap: number;
  allowlist: Recipient[];
  expiresAt: string | null;
  status: "active" | "revoked";
  ownerId?: string | null; // the signed-in user who created it; absent for mandates made with the admin token
}
export type NewMandate = Omit<Mandate, "id" | "agentToken" | "status">;

export interface PaymentRequest {
  amount: number;          // in the mandate's currency
  currency?: string;       // optional; if given it must equal the mandate currency
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
  currency: string;
  mandateId: string;
  verdict: Verdict;
  status: PaymentStatus;
  risk: number;            // 0–100, display only
  checks: Check[];
  reference?: string;      // tx hash, bank reference, transfer id — whatever the rail returns
  receiptUrl?: string;     // explorer link, receipt page, if the rail has one
  createdAt: string;
}

export interface Settler {
  name: string;                                  // "mock", "payfrom", "stripe", ...
  supports(currency: string): boolean;
  // idempotent on paymentId
  send(p: { paymentId: string; amount: number; currency: string; recipient: string }):
    Promise<{ reference: string; receiptUrl?: string }>;
}

export interface Limits {
  currency: string;
  monthlyCap: number; spentThisMonth: number; remaining: number;
  autoApproveMax: number; hardMax: number;
  allowedRecipients: Recipient[];
}

export interface Stats {
  total: number; approved: number; needsApproval: number; blocked: number;
  settledAmount: number; blockedAmount: number;   // in the mandate currency
}

// Result of re-computing the audit log's hash chain. brokenAt is the first row id that doesn't match.
export type AuditCheck = { ok: true; entries: number } | { ok: false; entries: number; brokenAt: number };

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
  listMandates(): Mandate[];                     // every mandate (agent), newest first
  revokeMandate(id: string): Mandate;
  listPayments(mandateId?: string): Payment[];   // newest first
  approvePayment(id: string): Promise<Payment>;  // only from pending_approval; settles
  denyPayment(id: string): Payment;
  stats(mandateId?: string): Stats;
  verifyAudit(): AuditCheck;                     // re-computes the audit log's hash chain
}
