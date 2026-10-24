// Sign in with Google (OpenID Connect, server-side code flow). On success the browser gets a session
// cookie the page's scripts cannot read. The admin token keeps working beside this, for local use and
// the benchmark.
import type { Database } from "bun:sqlite";
import { createSession, deleteSession, SESSION_DAYS, upsertGoogleUser, userForSession, type User } from "./users";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  publicUrl?: string;              // e.g. https://spend-firewall.onrender.com; else taken from the request
  doFetch?: typeof fetch;          // injectable for tests
  now?: () => Date;
}

export const SESSION_COOKIE = "sf_session";
const STATE_COOKIE = "sf_oauth_state";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export function authConfigFromEnv(env: Record<string, string | undefined> = process.env): AuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim(), clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  return { clientId, clientSecret, ...(publicUrl ? { publicUrl } : {}) };
}

export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The signed-in user for this request, if its session cookie is valid.
export function sessionUser(req: Request, db: Database, now = new Date()): User | null {
  const token = cookies(req)[SESSION_COOKIE];
  return token ? userForSession(db, token, now) : null;
}

// The site's own address. Behind Render's proxy the request says http, so trust the forwarded scheme.
function origin(req: Request, cfg: AuthConfig): string {
  if (cfg.publicUrl) return cfg.publicUrl;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

const cookie = (name: string, value: string, maxAge: number, secure: boolean, path = "/") =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

const redirect = (to: string, ...setCookies: string[]) => {
  const headers = new Headers({ location: to });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

const backWithError = (why: string, secure: boolean) =>
  redirect(`/?auth_error=${encodeURIComponent(why)}`, cookie(STATE_COOKIE, "", 0, secure, "/auth"));

// Decodes the id_token's claims. Its signature is not checked: the token came straight from Google's
// token endpoint over TLS, in exchange for our client secret, which is the case Google's OpenID docs
// allow. The audience, issuer, expiry and verified email are still checked.
function claims(idToken: string): any {
  const part = idToken.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export async function handleAuth(req: Request, db: Database, cfg: AuthConfig | null): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const now = cfg?.now ?? (() => new Date());

  if (path === "/auth/config") return Response.json({ google: !!cfg });

  if (path === "/auth/me") {
    const user = sessionUser(req, db, now());
    if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
    return Response.json({ id: user.id, email: user.email, name: user.name, telegramLinked: !!user.telegramChatId });
  }

  if (path === "/auth/logout") {
    if (req.method !== "POST") return Response.json({ error: `Method ${req.method} not allowed` }, { status: 405 });
    const token = cookies(req)[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": cookie(SESSION_COOKIE, "", 0, secure) },
    });
  }

  if (!cfg) return Response.json({ error: "Google sign-in is not set up on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)." }, { status: 503 });
  const base = origin(req, cfg);
  const secure = base.startsWith("https://");
  const redirectUri = `${base}/auth/google/callback`;

  if (path === "/auth/google") {
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const q = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code",
      scope: "openid email profile", state, prompt: "select_account",
    });
    return redirect(`${GOOGLE_AUTH}?${q}`, cookie(STATE_COOKIE, state, 600, secure, "/auth"));
  }

  if (path === "/auth/google/callback") {
    if (url.searchParams.get("error")) return backWithError("Google sign-in was cancelled.", secure);
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    const expected = cookies(req)[STATE_COOKIE];
    if (!code || !state || !expected || state !== expected) return backWithError("Sign-in expired or came from elsewhere. Please try again.", secure);

    let c: any;
    try {
      const res = await (cfg.doFetch ?? fetch)(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
        signal: AbortSignal.timeout(10_000),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.id_token !== "string") throw new Error(body.error_description ?? body.error ?? `token endpoint ${res.status}`);
      c = claims(body.id_token);
    } catch (err) {
      console.error(`google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      return backWithError("Google sign-in failed. Please try again.", secure);
    }

    const ok = c?.aud === cfg.clientId && ISSUERS.has(c?.iss) && typeof c?.exp === "number" && c.exp * 1000 > now().getTime()
      && typeof c?.sub === "string" && typeof c?.email === "string" && c.email_verified === true;
    if (!ok) return backWithError("Google did not confirm this account. Please try again.", secure);

    const user = upsertGoogleUser(db, { sub: c.sub, email: c.email, name: typeof c.name === "string" && c.name ? c.name : c.email }, now());
    const token = createSession(db, user.id, now());
    return redirect("/", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400, secure), cookie(STATE_COOKIE, "", 0, secure, "/auth"));
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
