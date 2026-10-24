import { core, db } from "./core";
import { handleApi, type Accounts } from "./api";
import { authConfigFromEnv, handleAuth } from "./auth";
import { drafterFromEnv } from "./compile";
import { handleMcp } from "./mcp/server";
import { startupMessage } from "./net";
import { startTelegramFromEnv, telegramLinkFromEnv } from "./telegram";

const port = Number(process.env.PORT ?? 3000);
const auth = authConfigFromEnv();
const drafter = drafterFromEnv();
const telegramLink = telegramLinkFromEnv();
const accounts: Accounts = { db, ...(telegramLink ? { telegramLink } : {}) };
console.log(auth ? "Google sign-in on." : "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set: sign in with the admin token only.");

const server = Bun.serve({
  port,
  hostname: "0.0.0.0", // reachable from a phone on the same network
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/mcp") return handleMcp(req, core);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, core, drafter, accounts);
    if (pathname.startsWith("/auth/")) return handleAuth(req, db, auth);
    if (pathname === "/") return new Response(Bun.file("public/index.html"));

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(startupMessage(server.port ?? port));
startTelegramFromEnv(core, db);
