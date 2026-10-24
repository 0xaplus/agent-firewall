// Append-only, hash-chained log of every payment event. Each row's hash covers the row and the
// previous row's hash, so editing or deleting a row breaks verification from that row on.
import type { Database } from "bun:sqlite";

export const GENESIS = "0".repeat(64);

export type AuditCheck = { ok: true; entries: number } | { ok: false; entries: number; brokenAt: number };

interface Row { id: number; payment_id: string; event: string; data: string; prev_hash: string; hash: string; created_at: string }

// Hashing the fields as a JSON array keeps them apart: "ab" + "c" and "a" + "bc" hash differently.
const digest = (prevHash: string, paymentId: string, event: string, data: string, createdAt: string) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify([prevHash, paymentId, event, data, createdAt])).digest("hex");

export function appendAudit(db: Database, paymentId: string, event: string, data: Record<string, unknown>, at = new Date()): void {
  const last = db.query("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | null;
  const prevHash = last?.hash ?? GENESIS;
  const json = JSON.stringify(data);
  const createdAt = at.toISOString();
  db.query("INSERT INTO audit_log (payment_id, event, data, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(paymentId, event, json, prevHash, digest(prevHash, paymentId, event, json, createdAt), createdAt);
}

export function verifyAudit(db: Database): AuditCheck {
  const rows = db.query("SELECT * FROM audit_log ORDER BY id").all() as Row[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== digest(r.prev_hash, r.payment_id, r.event, r.data, r.created_at)) {
      return { ok: false, entries: rows.length, brokenAt: r.id };
    }
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}
