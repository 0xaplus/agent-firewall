// Accounts: people who sign in with Google, their sessions, and the one-time codes that link a
// Telegram chat to an account. Session tokens and link codes are stored only as SHA-256 hashes,
// so a copy of the database cannot be used to sign in or to claim someone's Telegram link.
import type { Database } from "bun:sqlite";

export interface User { id: string; googleSub: string; email: string; name: string; telegramChatId: string | null; createdAt: string }

export const SESSION_DAYS = 30;
export const LINK_MINUTES = 10;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const toUser = (r: any): User => ({
  id: r.id, googleSub: r.google_sub, email: r.email, name: r.name, telegramChatId: r.telegram_chat_id ?? null, createdAt: r.created_at,
});

// Finds the account for this Google identity, creating it on first sign-in; email and name follow Google.
export function upsertGoogleUser(db: Database, g: { sub: string; email: string; name: string }, now = new Date()): User {
  const found = db.query("SELECT * FROM users WHERE google_sub = ?").get(g.sub);
  if (found) {
    db.query("UPDATE users SET email = ?, name = ? WHERE google_sub = ?").run(g.email, g.name, g.sub);
    return { ...toUser(found), email: g.email, name: g.name };
  }
  const id = `usr_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  db.query("INSERT INTO users (id, google_sub, email, name, telegram_chat_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
    .run(id, g.sub, g.email, g.name, now.toISOString());
  return toUser(db.query("SELECT * FROM users WHERE id = ?").get(id));
}

export function getUser(db: Database, id: string): User | null {
  const r = db.query("SELECT * FROM users WHERE id = ?").get(id);
  return r ? toUser(r) : null;
}

// ---- sessions ----

export function createSession(db: Database, userId: string, now = new Date()): string {
  const token = randomToken();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
  db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, expires);
  return token;
}

export function userForSession(db: Database, token: string, now = new Date()): User | null {
  const r = db.query("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as { user_id: string; expires_at: string } | null;
  if (!r) return null;
  if (r.expires_at <= now.toISOString()) { deleteSession(db, token); return null; }
  return getUser(db, r.user_id);
}

export function deleteSession(db: Database, token: string): void {
  db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

// ---- Telegram links: a code good for one use within LINK_MINUTES ----

export function createTelegramLink(db: Database, userId: string, now = new Date()): string {
  db.query("DELETE FROM telegram_links WHERE user_id = ? OR expires_at <= ?").run(userId, now.toISOString());
  const code = randomToken();
  const expires = new Date(now.getTime() + LINK_MINUTES * 60_000).toISOString();
  db.query("INSERT INTO telegram_links (code_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(code), userId, expires);
  return code;
}

// Uses the code up and links the chat. Returns the user, or null for an unknown, used or expired code.
// A chat belongs to one account at a time: linking it here unlinks it from anyone else.
export function redeemTelegramLink(db: Database, code: string, chatId: string, now = new Date()): User | null {
  const hash = sha256(code);
  const r = db.query("SELECT user_id, expires_at FROM telegram_links WHERE code_hash = ?").get(hash) as { user_id: string; expires_at: string } | null;
  db.query("DELETE FROM telegram_links WHERE code_hash = ?").run(hash);
  if (!r || r.expires_at <= now.toISOString()) return null;
  db.query("UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?").run(chatId);
  db.query("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(chatId, r.user_id);
  return getUser(db, r.user_id);
}

export function unlinkTelegram(db: Database, userId: string): void {
  db.query("UPDATE users SET telegram_chat_id = NULL WHERE id = ?").run(userId);
}

export function userForChat(db: Database, chatId: string): User | null {
  const r = db.query("SELECT * FROM users WHERE telegram_chat_id = ?").get(chatId);
  return r ? toUser(r) : null;
}
