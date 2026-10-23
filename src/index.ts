import { core } from "./core.fake"; // swap to "./core" at integration
import { handleApi } from "./api";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/mcp") {
      return Response.json({ error: "MCP server not implemented yet" }, { status: 501 }); // B3
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, core);
    if (pathname === "/") return new Response(Bun.file("public/index.html"));

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Spend Firewall listening on ${server.url}`);
