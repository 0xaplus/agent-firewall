import type { Database } from "bun:sqlite";
import { z } from "zod";
import { sessionUser } from "./auth";
import { budgetNotice } from "./budget";
import { drafterFromEnv, type Drafter } from "./compile";
import { CoreError } from "./errors";
import { NewMandateBody, nonEmpty } from "./schema";
import type { Core, Mandate, Stats } from "./types";
import { createTelegramLink, LINK_MINUTES, unlinkTelegram, type User } from "./users";

const DraftBody = z.object({ text: nonEmpty.max(4000) });

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false; // fail closed
  return req.headers.get("authorization") === `Bearer ${token}`;
}

// Accounts: present when the server signs people in with Google. Without it only the admin token works.
export interface Accounts {
  db: Database;
  telegramLink?: (code: string) => Promise<string | null>; // the t.me deep link for a code, null if Telegram is off
}

// Who is asking: the admin (sees everything) or a signed-in user (sees only their own agents).
type Who = { admin: true } | { admin: false; user: User };

export async function handleApi(req: Request, core: Core, drafter: Drafter | null = drafterFromEnv(), accounts?: Accounts): Promise<Response> {
  let who: Who;
  if (isAdmin(req)) who = { admin: true };
  else {
    const user = accounts ? sessionUser(req, accounts.db) : null;
    if (!user) return fail(401, "Unauthorized");
    // The session is a cookie, which a browser sends to any request to this site. A custom header
    // can only come from this site's own page, so writes without it are refused (CSRF).
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("x-sf-csrf") !== "1") return fail(403, "Missing x-sf-csrf header");
    who = { admin: false, user };
  }
  const mine = (m: Mandate | null): m is Mandate => !!m && (who.admin || m.ownerId === who.user.id);
  // Someone else's agent or payment reads as not found, so ids can't be probed.
  const ownMandate = (id: string): Mandate => {
    const m = core.getMandate(id);
    if (!mine(m)) throw new CoreError("not_found", `Mandate ${id} not found`);
    return m;
  };
  const ownPayment = (id: string) => {
    const p = core.getPayment(id);
    if (!p || !mine(core.getMandate(p.mandateId))) throw new CoreError("not_found", `Payment ${id} not found`);
    return p;
  };

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const mandateId = url.searchParams.get("mandateId") || undefined;
  const allow = (...methods: string[]) =>
    methods.includes(req.method) ? null : fail(405, `Method ${req.method} not allowed`);

  try {
    let m: RegExpMatchArray | null;

    if (path === "/api/mandates" && req.method === "GET") {
      // The agent token is shown only at creation and under "Connect an agent", never in the list.
      return json(core.listMandates().filter(mine).map(({ agentToken: _token, ...m }) => m));
    }

    if (path === "/api/mandates") {
      const bad = allow("GET", "POST");
      if (bad) return bad;
      let raw: unknown;
      try { raw = await req.json(); } catch { return fail(400, "Body must be valid JSON"); }
      const parsed = NewMandateBody.safeParse(raw);
      if (!parsed.success) {
        const i = parsed.error.issues[0]!;
        return fail(400, `Invalid ${i.path.join(".") || "body"}: ${i.message}`);
      }
      return json(core.createMandate(who.admin ? parsed.data : { ...parsed.data, ownerId: who.user.id }), 201);
    }

    // Returns a draft for the human to review. Creates nothing.
    if (path === "/api/mandates/draft") {
      const bad = allow("POST");
      if (bad) return bad;
      if (!drafter) return fail(503, "Drafting rules from plain English needs OPENROUTER_API_KEY on the server. Fill in the form yourself.");
      let raw: unknown;
      try { raw = await req.json(); } catch { return fail(400, "Body must be valid JSON"); }
      const parsed = DraftBody.safeParse(raw);
      if (!parsed.success) return fail(400, "Describe the rules in text, up to 4000 characters.");
      return json(await drafter(parsed.data.text));
    }

    if ((m = path.match(/^\/api\/mandates\/([^/]+)$/))) {
      const bad = allow("GET");
      if (bad) return bad;
      const mandate = core.getMandate(decodeURIComponent(m[1]!));
      return mine(mandate) ? json(mandate) : fail(404, "Mandate not found");
    }

    if ((m = path.match(/^\/api\/mandates\/([^/]+)\/limits$/))) {
      const bad = allow("GET");
      if (bad) return bad;
      const limits = core.getLimits(ownMandate(decodeURIComponent(m[1]!)).id);
      return json({ ...limits, budget: budgetNotice(limits.spentThisMonth, limits.monthlyCap) });
    }

    if ((m = path.match(/^\/api\/mandates\/([^/]+)\/revoke$/))) {
      const bad = allow("POST");
      if (bad) return bad;
      return json(core.revokeMandate(ownMandate(decodeURIComponent(m[1]!)).id));
    }

    if (path === "/api/payments") {
      const bad = allow("GET");
      if (bad) return bad;
      if (who.admin) return json(core.listPayments(mandateId));
      if (mandateId) return json(core.listPayments(ownMandate(mandateId).id));
      const ids = new Set(core.listMandates().filter(mine).map((x) => x.id));
      return json(core.listPayments().filter((p) => ids.has(p.mandateId)));
    }

    if ((m = path.match(/^\/api\/payments\/([^/]+)\/(approve|deny)$/))) {
      const bad = allow("POST");
      if (bad) return bad;
      const id = ownPayment(decodeURIComponent(m[1]!)).id;
      return json(m[2] === "approve" ? await core.approvePayment(id) : core.denyPayment(id));
    }

    if (path === "/api/audit/verify") {
      const bad = allow("GET");
      if (bad) return bad;
      return json(core.verifyAudit());
    }

    if (path === "/api/stats") {
      const bad = allow("GET");
      if (bad) return bad;
      if (who.admin) return json(core.stats(mandateId));
      if (mandateId) return json(core.stats(ownMandate(mandateId).id));
      const zero: Stats = { total: 0, approved: 0, needsApproval: 0, blocked: 0, settledAmount: 0, blockedAmount: 0 };
      return json(core.listMandates().filter(mine).map((x) => core.stats(x.id)).reduce((a, s) => ({
        total: a.total + s.total, approved: a.approved + s.approved, needsApproval: a.needsApproval + s.needsApproval,
        blocked: a.blocked + s.blocked, settledAmount: a.settledAmount + s.settledAmount, blockedAmount: a.blockedAmount + s.blockedAmount,
      }), zero));
    }

    // A one-time link that connects the user's Telegram chat to their account.
    if (path === "/api/telegram/link") {
      const bad = allow("POST");
      if (bad) return bad;
      if (who.admin) return fail(400, "Sign in with Google to connect Telegram; the admin token's chat is TELEGRAM_CHAT_ID.");
      const url = await accounts?.telegramLink?.(createTelegramLink(accounts.db, who.user.id));
      if (!url) return fail(503, "Telegram is not set up on this server (TELEGRAM_BOT_TOKEN).");
      return json({ url, expiresInMinutes: LINK_MINUTES });
    }

    if (path === "/api/telegram/unlink") {
      const bad = allow("POST");
      if (bad) return bad;
      if (who.admin) return fail(400, "Only a signed-in user can disconnect their Telegram.");
      unlinkTelegram(accounts!.db, who.user.id);
      return json({ ok: true });
    }

    return fail(404, "Not found");
  } catch (err) {
    if (err instanceof CoreError) return fail(err.kind === "not_found" ? 404 : 409, err.message);
    console.error("api error:", err);
    return fail(500, "Internal error");
  }
}
