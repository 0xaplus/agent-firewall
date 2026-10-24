import { core } from "./core";
import { handleApi } from "./api";
import { handleMcp } from "./mcp/server";
import { startupMessage } from "./net";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  hostname: "0.0.0.0", // reachable from a phone on the same network
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/mcp") return handleMcp(req, core);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, core);
    if (pathname === "/") return new Response(Bun.file("public/index.html"));

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(startupMessage(server.port ?? port));
