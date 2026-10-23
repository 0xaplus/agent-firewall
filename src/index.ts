import { core } from "./core.fake"; // swap to "./core" at integration
import { handleApi } from "./api";
import { handleMcp } from "./mcp/server";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/mcp") return handleMcp(req, core);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, core);
    if (pathname === "/") return new Response(Bun.file("public/index.html"));

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Spend Firewall listening on ${server.url}`);
