// Telegram approvals: a channel to the owner's phone, nothing more. Held payments arrive with
// Approve / Deny buttons that call the same Core methods as the dashboard, so every rule still applies.
// Long polling, so no public URL is needed. Any Telegram failure is logged and never reaches a payment.
import type { Database } from "bun:sqlite";
import { budgetNotice, type BudgetNotice } from "./budget";
import { getTelegramMessage, hasBudgetAlert, insertBudgetAlert, insertTelegramMessage, markTelegramFinal } from "./db";
import { CoreError } from "./errors";
import type { Core, Limits, Mandate, Payment } from "./types";
import { getUser, redeemTelegramLink, userForChat } from "./users";

export interface TelegramApi {
  call(method: string, params: object, signal?: AbortSignal): Promise<any>;
}

export class TelegramError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

// The token is part of every URL, so it is scrubbed from anything that could be logged.
export function telegramApi(token: string, doFetch: typeof fetch = fetch): TelegramApi {
  const scrub = (s: string) => s.replaceAll(token, "<token>");
  return {
    async call(method, params, signal) {
      let res: Response;
      try {
        res = await doFetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal,
        });
      } catch (err) {
        throw new TelegramError(scrub(`Telegram ${method} failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const status = body.error_code ?? res.status;
        throw new TelegramError(scrub(`Telegram ${method} failed (${status}): ${body.description ?? "no description"}`), status);
      }
      return body.result;
    },
  };
}

// ---- message text (plain text only: purpose and reasons come from the agent and may be hostile) ----

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const money = (p: Payment) => `${p.amount} ${p.currency}`;
const failedReasons = (p: Payment) => cut(p.checks.filter((c) => !c.pass).map((c) => c.reason).join(" "), 600);

function payee(p: Payment, m: Mandate | null): string {
  const r = m?.allowlist.find((x) => x.address === p.recipient);
  return r ? r.label : `${short(p.recipient)} (not on the allowlist)`;
}

function summary(p: Payment, m: Mandate | null): string[] {
  return [`${money(p)} → ${payee(p, m)}`, `Agent: ${m?.name ?? p.mandateId}`];
}

export function heldText(p: Payment, m: Mandate | null): string {
  const [line, agent] = summary(p, m);
  return ["⏸ Payment waiting for you", line, `For: ${cut(p.purpose, 200)}`, agent, `Held because: ${failedReasons(p)}`, `ID: ${p.id}`].join("\n");
}

export function blockedText(p: Payment, m: Mandate | null): string {
  const [line, agent] = summary(p, m);
  return ["🛑 Payment blocked", line, agent, `Why: ${failedReasons(p)}`, `ID: ${p.id}`].join("\n");
}

// What happened to a payment, as the first line of the edited message.
export function outcomeLine(p: Payment, how: "approved" | "denied" | "elsewhere"): string {
  const last = p.checks.at(-1);
  if (how === "denied") return "❌ Denied by you.";
  if (how === "approved") {
    if (p.status === "settled") return `✅ Approved — settled. Ref ${short(p.reference ?? "")}`;
    if ((p.status === "denied" || p.status === "failed") && last && !last.pass) return `⛔ Not paid: ${last.reason}`;
    return `ℹ️ Approved — ${p.status.replaceAll("_", " ")}`;
  }
  const why = p.status === "denied" && last && !last.pass && last.severity === "block" ? ` (${last.reason})` : "";
  return `ℹ️ Already decided elsewhere: ${p.status.replaceAll("_", " ")}${why}`;
}

const amount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
export const budgetAlertText = (m: Mandate, l: Limits, n: BudgetNotice) =>
  `⚠️ ${m.name} has used ${n.pct}% of its monthly budget (${amount(l.spentThisMonth)} of ${amount(l.monthlyCap)} ${l.currency}).`;

// A link to the payment on the chain's explorer, once it has settled and the rail gave one.
const receiptLine = (p: Payment) => (p.status === "settled" && p.receiptUrl ? [`🧾 Receipt: ${p.receiptUrl}`] : []);

const decidedText = (p: Payment, m: Mandate | null, how: "approved" | "denied" | "elsewhere") =>
  [outcomeLine(p, how), ...summary(p, m), ...receiptLine(p), `ID: ${p.id}`].join("\n");

// A payment the firewall approved on its own and that settled: no decision needed, just the receipt.
export function paidText(p: Payment, m: Mandate | null): string {
  const [line, agent] = summary(p, m);
  return [`✅ Paid${p.reference ? `. Ref ${short(p.reference)}` : ""}`, line, `For: ${cut(p.purpose, 200)}`, agent, ...receiptLine(p), `ID: ${p.id}`].join("\n");
}

const keyboard = (id: string) => ({ inline_keyboard: [[{ text: "Approve", callback_data: `a:${id}` }, { text: "Deny", callback_data: `d:${id}` }]] });

// ---- the module ----

export interface TelegramOptions {
  core: Core;
  db: Database;
  api: TelegramApi;
  chatId: string | null;           // the admin's chat, for mandates made with the admin token; null: none
                                   // (a signed-in user's mandates go to the chat they linked from the dashboard)
  notifyBlocked?: boolean;
  notifyPaid?: boolean;            // also report payments approved without you, with their receipt
  now?: () => Date;
  log?: (msg: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export function createTelegram(opts: TelegramOptions) {
  const { core, db, api, chatId } = opts;
  const notifyBlocked = opts.notifyBlocked ?? true;
  const notifyPaid = opts.notifyPaid ?? true;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const deciding = new Set<string>(); // taps in progress: the tick leaves these alone
  const mandates = new Map<string, Mandate | null>();
  const mandateOf = (id: string) => {
    if (!mandates.has(id)) mandates.set(id, core.getMandate(id));
    return mandates.get(id)!;
  };
  const fresh = (id: string) => { mandates.delete(id); return mandateOf(id); };
  // Where a mandate's messages go: its owner's linked chat, or the admin chat for admin-made mandates.
  const chatFor = (m: Mandate | null): string | null =>
    m?.ownerId ? getUser(db, m.ownerId)?.telegramChatId ?? null : chatId;

  const edit = async (chat: string, messageId: number, text: string) => {
    try {
      await api.call("editMessageText", { chat_id: chat, message_id: messageId, text });
    } catch (err) {
      if (!String((err as Error).message).includes("message is not modified")) throw err;
    }
  };

  // One pass: notify new held and blocked payments, and update messages decided elsewhere.
  async function tick(): Promise<void> {
    let payments: Payment[];
    try { payments = core.listPayments(); } catch (err) { log(`telegram: could not list payments: ${(err as Error).message}`); return; }
    for (const p of [...payments].reverse()) {
      if (deciding.has(p.id)) continue;
      try {
        const rec = getTelegramMessage(db, p.id);
        if (!rec) {
          const held = p.status === "pending_approval";
          const blocked = notifyBlocked && p.verdict === "blocked" && p.createdAt >= startedAt;
          const paid = notifyPaid && p.verdict === "approved" && p.status === "settled" && p.createdAt >= startedAt;
          if (!held && !blocked && !paid) continue;
          const m = held ? fresh(p.mandateId) : mandateOf(p.mandateId);
          const target = chatFor(m);
          if (!target) continue; // nobody to tell yet; picked up once they link Telegram
          const sent = await api.call("sendMessage", held
            ? { chat_id: target, text: heldText(p, m), reply_markup: keyboard(p.id) }
            : { chat_id: target, text: blocked ? blockedText(p, m) : paidText(p, m) });
          insertTelegramMessage(db, { paymentId: p.id, chatId: target, messageId: sent.message_id, kind: held ? "held" : blocked ? "blocked" : "paid", final: !held, createdAt: new Date().toISOString() });
        } else if (!rec.final && p.status !== "pending_approval") {
          await edit(rec.chatId, rec.messageId, decidedText(p, mandateOf(p.mandateId), "elsewhere"));
          markTelegramFinal(db, p.id);
        }
      } catch (err) {
        log(`telegram: ${p.id}: ${(err as Error).message}`); // retried on the next tick
      }
    }
    await budgetAlerts();
  }

  // Once per mandate per month, when its spend first reaches 80% of the cap. A notice only.
  async function budgetAlerts(): Promise<void> {
    const at = now();
    const month = at.toISOString().slice(0, 7);
    let list: Mandate[];
    try { list = core.listMandates(); } catch (err) { log(`telegram: could not list mandates: ${(err as Error).message}`); return; }
    for (const m of list) {
      if (m.status !== "active") continue;
      try {
        if (hasBudgetAlert(db, m.id, month)) continue;
        const limits = core.getLimits(m.id);
        const notice = budgetNotice(limits.spentThisMonth, limits.monthlyCap);
        if (notice.level === "ok") continue;
        const target = chatFor(m);
        if (!target) continue;
        await api.call("sendMessage", { chat_id: target, text: budgetAlertText(m, limits, notice) });
        insertBudgetAlert(db, m.id, month, at.toISOString());
      } catch (err) {
        log(`telegram: budget alert for ${m.id}: ${(err as Error).message}`); // retried on the next tick
      }
    }
  }

  async function onStart(chat: string, code?: string): Promise<void> {
    // Opened from the dashboard's Connect Telegram link: the code says whose account this chat is.
    if (code) {
      const user = redeemTelegramLink(db, code, chat, now());
      await api.call("sendMessage", { chat_id: chat, text: user
        ? `Connected to ${user.email}. Payments from your agents will appear here.`
        : "That link has expired or was already used. Open the dashboard and tap Connect Telegram again." });
      return;
    }
    const linked = userForChat(db, chat);
    if (linked) {
      await api.call("sendMessage", { chat_id: chat, text: `Connected to ${linked.email}. Payments from your agents will appear here.` });
    } else if (!chatId) {
      const hint = `Your chat id is ${chat}. Set TELEGRAM_CHAT_ID=${chat} in .env and restart the server.`;
      log(`telegram: ${hint}`);
      await api.call("sendMessage", { chat_id: chat, text: hint });
    } else if (chat === chatId) {
      await api.call("sendMessage", { chat_id: chat, text: "Connected. Held payments will appear here." });
    } else {
      log(`telegram: ignored /start from chat ${chat}`);
    }
  }

  async function onTap(cq: any): Promise<void> {
    const chat = String(cq.message?.chat?.id ?? "");
    const match = /^([ad]):(\S+)$/.exec(String(cq.data ?? ""));
    // Only the chat that owns this payment's mandate may decide it.
    const payment = match ? core.getPayment(match[2]!) : null;
    const owner = payment ? chatFor(mandateOf(payment.mandateId)) : null;
    const allowed = !!match && !!owner && chat === owner;
    await api.call("answerCallbackQuery", { callback_query_id: cq.id, text: !allowed ? "Not allowed" : match![1] === "a" ? "Approving…" : "Denying…" });
    if (!allowed) { log(`telegram: ignored a button tap from chat ${chat}`); return; }

    const [, action, id] = match!;
    const messageId: number = cq.message.message_id;
    deciding.add(id!);
    try {
      let text: string;
      try {
        const p = action === "a" ? await core.approvePayment(id!) : core.denyPayment(id!);
        text = decidedText(p, mandateOf(p.mandateId), action === "a" ? "approved" : "denied");
      } catch (err) {
        const now = err instanceof CoreError ? core.getPayment(id!) : null;
        if (now) text = decidedText(now, mandateOf(now.mandateId), "elsewhere");
        else {
          if (!(err instanceof CoreError)) log(`telegram: deciding ${id} failed: ${(err as Error).message}`);
          text = "Something went wrong; decide on the dashboard.";
        }
      }
      markTelegramFinal(db, id!);
      await edit(chat, messageId, text);
    } finally {
      deciding.delete(id!);
    }
  }

  async function handleUpdate(u: any): Promise<void> {
    if (u.callback_query) return onTap(u.callback_query);
    const text = u.message?.text;
    const start = typeof text === "string" ? /^\/start(?:@\S+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/.exec(text.trim()) : null;
    if (start) return onStart(String(u.message.chat.id), start[1]);
  }

  // Long polling. Errors back off 2 s, doubling to 30 s; a 409 (another poller) is logged once.
  async function pollLoop(signal: AbortSignal): Promise<void> {
    let offset = 0, delay = 2000, said409 = false;
    while (!signal.aborted) {
      try {
        const updates: any[] = await api.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, signal);
        delay = 2000;
        for (const u of updates) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (err) { log(`telegram: update ${u.update_id}: ${(err as Error).message}`); }
        }
      } catch (err) {
        if (signal.aborted) break;
        if (err instanceof TelegramError && err.status === 409) {
          if (!said409) log("telegram: another process is polling this bot (409); backing off until it stops.");
          said409 = true;
        } else {
          log(`telegram: ${(err as Error).message}; retrying in ${delay / 1000} s`);
        }
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  return { tick, handleUpdate, pollLoop };
}

// Starts both loops. Returns a stop function.
export function startTelegram(opts: TelegramOptions & { intervalMs?: number }): () => void {
  const t = createTelegram(opts);
  const ac = new AbortController();
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await t.tick(); } finally { running = false; }
  }, opts.intervalMs ?? 2000);
  void t.pollLoop(ac.signal);
  return () => { ac.abort(); clearInterval(timer); };
}

// Off unless TELEGRAM_BOT_TOKEN is set; setup mode until TELEGRAM_CHAT_ID is set too.
export function startTelegramFromEnv(core: Core, db: Database, env: Record<string, string | undefined> = process.env,
  log: (m: string) => void = (m) => console.log(m)): (() => void) | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) { log("TELEGRAM_BOT_TOKEN not set: Telegram approvals are off."); return null; }
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || null;
  log(chatId ? "Telegram approvals on: admin mandates go to TELEGRAM_CHAT_ID; signed-in users connect their own chat from the dashboard."
    : "Telegram on: signed-in users connect their own chat from the dashboard. (Send /start to the bot for a chat id to use as TELEGRAM_CHAT_ID for admin mandates.)");
  return startTelegram({ core, db, api: telegramApi(token), chatId, notifyBlocked: env.TELEGRAM_NOTIFY_BLOCKED !== "0", notifyPaid: env.TELEGRAM_NOTIFY_PAID !== "0", log });
}

// The t.me link that opens this bot with a start code. The bot's username comes from getMe, once.
export function telegramLinkFromEnv(env: Record<string, string | undefined> = process.env, doFetch: typeof fetch = fetch):
  ((code: string) => Promise<string | null>) | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return undefined;
  const fixed = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  let username: Promise<string | null> | null = fixed ? Promise.resolve(fixed) : null;
  return async (code) => {
    username ??= telegramApi(token, doFetch).call("getMe", {}).then((me) => (typeof me?.username === "string" ? me.username : null))
      .catch((err) => { console.warn(`telegram: getMe failed: ${(err as Error).message}`); username = null; return null; });
    const name = await username;
    return name ? `https://t.me/${name}?start=${code}` : null;
  };
}
