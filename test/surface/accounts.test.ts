import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleApi, type Accounts } from "../../src/api";
import { handleAuth, type AuthConfig } from "../../src/auth";
import { getTelegramMessage } from "../../src/db";
import { DEMO_MANDATE } from "../../src/fixtures";
import { createTelegram, type TelegramApi } from "../../src/telegram";
import type { Core } from "../../src/types";
import { createSession, createTelegramLink, getUser, redeemTelegramLink, upsertGoogleUser, userForSession, type User } from "../../src/users";
import { testSetup } from "../helpers/testCore";

const { id: _i, agentToken: _t, status: _s, ...NEW_MANDATE } = DEMO_MANDATE;
const SHENZHEN = DEMO_MANDATE.allowlist[2]!.address;

let core: Core;
let db: Database;
let saved: string | undefined;
let ada: User, bola: User;
let adaCookie: string, bolaCookie: string;
beforeEach(() => {
  ({ core, db } = testSetup());
  saved = process.env.ADMIN_TOKEN; process.env.ADMIN_TOKEN = "test";
  ada = upsertGoogleUser(db, { sub: "g-ada", email: "ada@example.com", name: "Ada" });
  bola = upsertGoogleUser(db, { sub: "g-bola", email: "bola@example.com", name: "Bola" });
  adaCookie = `sf_session=${createSession(db, ada.id)}`;
  bolaCookie = `sf_session=${createSession(db, bola.id)}`;
});
afterEach(() => { if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved; });

const accounts = (over: Partial<Accounts> = {}): Accounts => ({ db, telegramLink: async (code) => `https://t.me/sf_bot?start=${code}`, ...over });
const as = (cookie: string | null, method: string, path: string, body?: unknown, { csrf = true, admin = false } = {}) =>
  handleApi(new Request(`http://x${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}), ...(admin ? { authorization: "Bearer test" } : {}),
      ...(csrf && method !== "GET" ? { "x-sf-csrf": "1" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), core, null, accounts());
const create = async (cookie: string) => (await (await as(cookie, "POST", "/api/mandates", NEW_MANDATE)).json()) as any;

describe("sessions and Telegram link codes", () => {
  test("a session finds its user until it expires; only its hash is stored", () => {
    const token = createSession(db, ada.id, new Date("2026-01-01T00:00:00Z"));
    expect(userForSession(db, token, new Date("2026-01-15T00:00:00Z"))?.email).toBe("ada@example.com");
    expect(userForSession(db, token, new Date("2026-03-01T00:00:00Z"))).toBeNull();
    expect(userForSession(db, "made-up")).toBeNull();
    expect(JSON.stringify(db.query("SELECT * FROM sessions").all())).not.toContain(token);
  });

  test("signing in again with the same Google account is the same user, with Google's latest email and name", () => {
    const again = upsertGoogleUser(db, { sub: "g-ada", email: "ada@new.example", name: "Ada L." });
    expect(again.id).toBe(ada.id);
    expect(getUser(db, ada.id)).toMatchObject({ email: "ada@new.example", name: "Ada L." });
  });

  test("a link code works once, within 10 minutes, and a chat belongs to one account", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const code = createTelegramLink(db, ada.id, t0);
    expect(redeemTelegramLink(db, code, "555", new Date(t0.getTime() + 60_000))?.id).toBe(ada.id);
    expect(redeemTelegramLink(db, code, "555")).toBeNull();
    const late = createTelegramLink(db, bola.id, t0);
    expect(redeemTelegramLink(db, late, "777", new Date(t0.getTime() + 11 * 60_000))).toBeNull();
    // Bola links the chat Ada had: it moves.
    expect(redeemTelegramLink(db, createTelegramLink(db, bola.id), "555")?.id).toBe(bola.id);
    expect(getUser(db, ada.id)!.telegramChatId).toBeNull();
  });
});

describe("each user sees only their own agents", () => {
  test("a mandate belongs to the user who created it", async () => {
    const m = await create(adaCookie);
    expect(m.ownerId).toBe(ada.id);
    const adaList = (await (await as(adaCookie, "GET", "/api/mandates")).json()) as any[];
    const bolaList = (await (await as(bolaCookie, "GET", "/api/mandates")).json()) as any[];
    expect(adaList.map((x) => x.id)).toEqual([m.id]);
    expect(bolaList).toEqual([]); // not even the seeded admin mandate
  });

  test("someone else's mandate and payments read as not found, and can't be revoked or decided", async () => {
    const m = await create(adaCookie);
    const p = await core.requestPayment(m.id, { amount: 650, recipient: SHENZHEN, purpose: "parts" });
    expect(p.status).toBe("pending_approval");
    for (const [method, path] of [
      ["GET", `/api/mandates/${m.id}`], ["GET", `/api/mandates/${m.id}/limits`], ["POST", `/api/mandates/${m.id}/revoke`],
      ["GET", `/api/payments?mandateId=${m.id}`], ["POST", `/api/payments/${p.id}/approve`], ["POST", `/api/payments/${p.id}/deny`],
      ["GET", `/api/stats?mandateId=${m.id}`],
    ] as const) expect((await as(bolaCookie, method, path)).status).toBe(404);
    expect(((await (await as(bolaCookie, "GET", "/api/payments")).json()) as any[])).toEqual([]);
    expect(core.getPayment(p.id)!.status).toBe("pending_approval");
    expect(core.getMandate(m.id)!.status).toBe("active");
    expect((await as(adaCookie, "POST", `/api/payments/${p.id}/deny`)).status).toBe(200);
  });

  test("the admin token still sees everything", async () => {
    const m = await create(adaCookie);
    const all = (await (await as(null, "GET", "/api/mandates", undefined, { admin: true })).json()) as any[];
    expect(all.map((x) => x.id).sort()).toEqual([DEMO_MANDATE.id, m.id].sort());
  });

  test("a write on a session cookie without the x-sf-csrf header is refused", async () => {
    const res = await as(adaCookie, "POST", "/api/mandates", NEW_MANDATE, { csrf: false });
    expect(res.status).toBe(403);
    expect(core.listMandates().filter((m) => m.ownerId === ada.id)).toEqual([]);
  });

  test("no cookie, an unknown cookie, or a signed-out session is 401", async () => {
    expect((await as(null, "GET", "/api/mandates")).status).toBe(401);
    expect((await as("sf_session=nope", "GET", "/api/mandates")).status).toBe(401);
  });
});

describe("Connect Telegram", () => {
  test("a signed-in user gets a one-time t.me link; the admin token does not", async () => {
    const res = await as(adaCookie, "POST", "/api/telegram/link");
    const body = (await res.json()) as any;
    expect(body.url).toMatch(/^https:\/\/t\.me\/sf_bot\?start=[A-Za-z0-9_-]{43}$/);
    expect(body.expiresInMinutes).toBe(10);
    expect((await as(null, "POST", "/api/telegram/link", undefined, { admin: true })).status).toBe(400);
  });

  test("without a bot the link is 503", async () => {
    const res = await handleApi(new Request("http://x/api/telegram/link", { method: "POST", headers: { cookie: adaCookie, "x-sf-csrf": "1" } }),
      core, null, accounts({ telegramLink: async () => null }));
    expect(res.status).toBe(503);
  });

  test("unlink stops messages going to the chat", async () => {
    redeemTelegramLink(db, createTelegramLink(db, ada.id), "555");
    expect((await as(adaCookie, "POST", "/api/telegram/unlink")).status).toBe(200);
    expect(getUser(db, ada.id)!.telegramChatId).toBeNull();
  });
});

describe("Telegram routes each user's payments to their own chat", () => {
  interface Call { method: string; params: any }
  const fake = () => {
    const calls: Call[] = [];
    let id = 900;
    const api: TelegramApi = { async call(method, params) { calls.push({ method, params }); return method === "sendMessage" ? { message_id: id++ } : true; } };
    return { api, calls, sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params) };
  };
  const ADMIN_CHAT = "111", ADA_CHAT = "555", BOLA_CHAT = "777";
  let tg: ReturnType<typeof fake>;
  const telegram = () => createTelegram({ core, db, api: tg.api, chatId: ADMIN_CHAT, log: () => {}, now: () => new Date(Date.now() - 1000) });
  const tap = (t: ReturnType<typeof telegram>, data: string, chat: string) =>
    t.handleUpdate({ update_id: 1, callback_query: { id: "cq", data, message: { message_id: 900, chat: { id: Number(chat) } } } });
  beforeEach(() => { tg = fake(); });

  test("/start with a code links the chat and says whose account it is", async () => {
    const t = telegram();
    await t.handleUpdate({ update_id: 1, message: { text: `/start ${createTelegramLink(db, ada.id)}`, chat: { id: Number(ADA_CHAT) } } });
    expect(getUser(db, ada.id)!.telegramChatId).toBe(ADA_CHAT);
    expect(tg.sent()[0]).toEqual({ chat_id: ADA_CHAT, text: "Connected to ada@example.com. Payments from your agents will appear here." });
    await t.handleUpdate({ update_id: 2, message: { text: "/start used-or-made-up-code", chat: { id: Number(BOLA_CHAT) } } });
    expect(tg.sent()[1]!.text).toContain("expired or was already used");
    expect(getUser(db, bola.id)!.telegramChatId).toBeNull();
  });

  test("a held payment goes to its owner's chat, and only that chat can decide it", async () => {
    redeemTelegramLink(db, createTelegramLink(db, ada.id), ADA_CHAT);
    redeemTelegramLink(db, createTelegramLink(db, bola.id), BOLA_CHAT);
    const m = core.createMandate({ ...NEW_MANDATE, ownerId: ada.id });
    const p = await core.requestPayment(m.id, { amount: 650, recipient: SHENZHEN, purpose: "parts" });
    const t = telegram();
    await t.tick();
    expect(tg.sent().map((s) => s.chat_id)).toEqual([ADA_CHAT]);
    await tap(t, `a:${p.id}`, BOLA_CHAT);
    await tap(t, `a:${p.id}`, ADMIN_CHAT);
    expect(core.getPayment(p.id)!.status).toBe("pending_approval");
    await tap(t, `d:${p.id}`, ADA_CHAT);
    expect(core.getPayment(p.id)!.status).toBe("denied");
  });

  test("a user who hasn't linked Telegram gets nothing until they do; admin mandates still go to TELEGRAM_CHAT_ID", async () => {
    const m = core.createMandate({ ...NEW_MANDATE, ownerId: ada.id });
    const p = await core.requestPayment(m.id, { amount: 650, recipient: SHENZHEN, purpose: "parts" });
    const adminP = await core.requestPayment(DEMO_MANDATE.id, { amount: 650, recipient: SHENZHEN, purpose: "parts" });
    const t = telegram();
    await t.tick();
    expect(tg.sent().map((s) => s.chat_id)).toEqual([ADMIN_CHAT]);
    expect(getTelegramMessage(db, adminP.id)?.chatId).toBe(ADMIN_CHAT);
    redeemTelegramLink(db, createTelegramLink(db, ada.id), ADA_CHAT);
    await t.tick();
    expect(getTelegramMessage(db, p.id)?.chatId).toBe(ADA_CHAT);
  });
});

describe("Google sign-in routes", () => {
  const CLIENT = "client-123.apps.googleusercontent.com";
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const good = { iss: "https://accounts.google.com", aud: CLIENT, sub: "g-new", email: "new@example.com", email_verified: true, name: "New Person", exp: Math.floor(Date.now() / 1000) + 3600 };
  const cfg = (claims: object, seen: { body?: string } = {}): AuthConfig => ({
    clientId: CLIENT, clientSecret: "secret", publicUrl: "https://sf.example",
    doFetch: (async (_url: string, init: RequestInit) => { seen.body = String(init.body); return Response.json({ id_token: jwt(claims) }); }) as unknown as typeof fetch,
  });
  const get = (path: string, c: AuthConfig | null, cookie?: string) =>
    handleAuth(new Request(`https://sf.example${path}`, { headers: cookie ? { cookie } : {} }), db, c);
  const stateOf = (res: Response) => /sf_oauth_state=([^;]+)/.exec(res.headers.getSetCookie().join("\n"))![1]!;

  test("/auth/google sends you to Google with a state that is also set as a cookie", async () => {
    const res = await get("/auth/google", cfg(good));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("redirect_uri")).toBe("https://sf.example/auth/google/callback");
    expect(to.searchParams.get("scope")).toBe("openid email profile");
    expect(to.searchParams.get("state")).toBe(stateOf(res));
    expect(res.headers.getSetCookie()[0]).toContain("HttpOnly");
  });

  test("the callback signs you in: a new user, a session cookie, back to the dashboard", async () => {
    const seen: { body?: string } = {};
    const c = cfg(good, seen);
    const state = stateOf(await get("/auth/google", c));
    const res = await get(`/auth/google/callback?code=abc&state=${state}`, c, `sf_oauth_state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(seen.body).toContain("client_secret=secret");
    const session = /sf_session=([^;]+)/.exec(res.headers.getSetCookie().join("\n"))![1]!;
    expect(res.headers.getSetCookie().find((s) => s.startsWith("sf_session="))).toMatch(/HttpOnly; SameSite=Lax; Secure/);
    const me = await get("/auth/me", c, `sf_session=${session}`);
    expect(await me.json()).toMatchObject({ email: "new@example.com", name: "New Person", telegramLinked: false });
  });

  test("a state that doesn't match the cookie is refused", async () => {
    const res = await get("/auth/google/callback?code=abc&state=evil", cfg(good), "sf_oauth_state=mine");
    expect(res.headers.get("location")).toStartWith("/?auth_error=");
    expect(res.headers.getSetCookie().join("\n")).not.toContain("sf_session=");
  });

  for (const [why, claims] of [
    ["another app's token", { ...good, aud: "someone-else" }],
    ["an unverified email", { ...good, email_verified: false }],
    ["an expired token", { ...good, exp: 1 }],
    ["the wrong issuer", { ...good, iss: "https://evil.example" }],
  ] as const) {
    test(`${why} does not sign you in`, async () => {
      const res = await get("/auth/google/callback?code=abc&state=s", cfg(claims), "sf_oauth_state=s");
      expect(res.headers.get("location")).toStartWith("/?auth_error=");
      expect(db.query("SELECT COUNT(*) AS n FROM users WHERE google_sub = 'g-new'").get()).toEqual({ n: 0 });
    });
  }

  test("logout ends the session", async () => {
    const res = await handleAuth(new Request("https://sf.example/auth/logout", { method: "POST", headers: { cookie: adaCookie } }), db, null);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(userForSession(db, adaCookie.split("=")[1]!)).toBeNull();
  });

  test("without Google configured, /auth/config says so and /auth/google is 503", async () => {
    expect(await (await get("/auth/config", null)).json()).toEqual({ google: false });
    expect((await get("/auth/google", null)).status).toBe(503);
  });
});
