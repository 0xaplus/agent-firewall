import { Database } from "bun:sqlite";
import type { Check, Mandate, Payment, PaymentStatus } from "./types";

// Spend that counts against the monthly cap: settled money plus money in flight.
const SPENDING: PaymentStatus[] = ["settled", "settling"];

export function openDb(path = process.env.DB_PATH ?? "firewall.db"): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS mandates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    task TEXT NOT NULL,
    currency TEXT NOT NULL,
    agent_token TEXT NOT NULL UNIQUE,
    auto_approve_max REAL NOT NULL,
    hard_max REAL NOT NULL,
    monthly_cap REAL NOT NULL,
    allowlist TEXT NOT NULL,
    expires_at TEXT,
    status TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    mandate_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    recipient TEXT NOT NULL,
    purpose TEXT NOT NULL,
    context TEXT,
    verdict TEXT NOT NULL,
    status TEXT NOT NULL,
    risk INTEGER NOT NULL,
    checks TEXT NOT NULL,
    reference TEXT,
    receipt_url TEXT,
    created_at TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS payments_mandate_created ON payments (mandate_id, created_at)");
  return db;
}

// ---- mandates ----

const toMandate = (r: any): Mandate => ({
  id: r.id, name: r.name, task: r.task, currency: r.currency, agentToken: r.agent_token,
  autoApproveMax: r.auto_approve_max, hardMax: r.hard_max, monthlyCap: r.monthly_cap,
  allowlist: JSON.parse(r.allowlist), expiresAt: r.expires_at, status: r.status,
});

export function insertMandate(db: Database, m: Mandate): void {
  db.query(`INSERT INTO mandates VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.id, m.name, m.task, m.currency, m.agentToken, m.autoApproveMax, m.hardMax, m.monthlyCap,
    JSON.stringify(m.allowlist), m.expiresAt, m.status,
  );
}

export function getMandate(db: Database, id: string): Mandate | null {
  const r = db.query("SELECT * FROM mandates WHERE id = ?").get(id);
  return r ? toMandate(r) : null;
}

export function getMandateByToken(db: Database, token: string): Mandate | null {
  const r = db.query("SELECT * FROM mandates WHERE agent_token = ?").get(token);
  return r ? toMandate(r) : null;
}

export function setMandateStatus(db: Database, id: string, status: Mandate["status"]): void {
  db.query("UPDATE mandates SET status = ? WHERE id = ?").run(status, id);
}

// ---- payments ----

const toPayment = (r: any): Payment => ({
  id: r.id, mandateId: r.mandate_id, amount: r.amount, currency: r.currency,
  recipient: r.recipient, purpose: r.purpose,
  ...(r.context != null ? { context: r.context } : {}),
  verdict: r.verdict, status: r.status, risk: r.risk, checks: JSON.parse(r.checks),
  ...(r.reference != null ? { reference: r.reference } : {}),
  ...(r.receipt_url != null ? { receiptUrl: r.receipt_url } : {}),
  createdAt: r.created_at,
});

export function insertPayment(db: Database, p: Payment): void {
  db.query(`INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    p.id, p.mandateId, p.amount, p.currency, p.recipient, p.purpose, p.context ?? null,
    p.verdict, p.status, p.risk, JSON.stringify(p.checks), p.reference ?? null, p.receiptUrl ?? null, p.createdAt,
  );
}

export function getPayment(db: Database, id: string): Payment | null {
  const r = db.query("SELECT * FROM payments WHERE id = ?").get(id);
  return r ? toPayment(r) : null;
}

export type PaymentPatch = Partial<Pick<Payment, "reference" | "receiptUrl" | "checks">>;

// Applies only if the payment is still in `from`, which stops double approvals. Only src/payments.ts calls this.
export function movePayment(db: Database, id: string, from: PaymentStatus, to: PaymentStatus, patch: PaymentPatch = {}): boolean {
  const sets = ["status = ?"];
  const vals: (string | null)[] = [to];
  if (patch.reference !== undefined) { sets.push("reference = ?"); vals.push(patch.reference); }
  if (patch.receiptUrl !== undefined) { sets.push("receipt_url = ?"); vals.push(patch.receiptUrl); }
  if (patch.checks !== undefined) { sets.push("checks = ?"); vals.push(JSON.stringify(patch.checks as Check[])); }
  return db.query(`UPDATE payments SET ${sets.join(", ")} WHERE id = ? AND status = ?`).run(...vals, id, from).changes === 1;
}

// Newest first.
export function listPayments(db: Database, mandateId?: string): Payment[] {
  const rows = mandateId
    ? db.query("SELECT * FROM payments WHERE mandate_id = ? ORDER BY created_at DESC, rowid DESC").all(mandateId)
    : db.query("SELECT * FROM payments ORDER BY created_at DESC, rowid DESC").all();
  return rows.map(toPayment);
}

const marks = (xs: unknown[]) => xs.map(() => "?").join(",");

// Settled or in-flight spend since the start of the current UTC month.
export function monthSpend(db: Database, mandateId: string, now = new Date()): number {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const r = db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE mandate_id = ? AND created_at >= ? AND status IN (${marks(SPENDING)})`,
  ).get(mandateId, monthStart, ...SPENDING) as { total: number };
  return r.total;
}

// Every request in the last `minutes`, whatever its outcome.
export function recentPayments(db: Database, mandateId: string, minutes: number, now = new Date()): Payment[] {
  const since = new Date(now.getTime() - minutes * 60_000).toISOString();
  return db.query("SELECT * FROM payments WHERE mandate_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC")
    .all(mandateId, since).map(toPayment);
}

// Amounts of past payments to this recipient that actually settled.
export function historyTo(db: Database, mandateId: string, recipient: string): number[] {
  return (db.query("SELECT amount FROM payments WHERE mandate_id = ? AND recipient = ? AND status = 'settled' ORDER BY created_at")
    .all(mandateId, recipient) as { amount: number }[]).map((r) => r.amount);
}
