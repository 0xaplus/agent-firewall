import { z } from "zod";
import { CoreError } from "./errors";
import { NewMandateBody } from "./schema";
import type { Core } from "./types";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

function authorized(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false; // fail closed
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export async function handleApi(req: Request, core: Core): Promise<Response> {
  if (!authorized(req)) return fail(401, "Unauthorized");

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const mandateId = url.searchParams.get("mandateId") || undefined;
  const allow = (...methods: string[]) =>
    methods.includes(req.method) ? null : fail(405, `Method ${req.method} not allowed`);

  try {
    let m: RegExpMatchArray | null;

    if (path === "/api/mandates") {
      const bad = allow("POST");
      if (bad) return bad;
      let raw: unknown;
      try { raw = await req.json(); } catch { return fail(400, "Body must be valid JSON"); }
      const parsed = NewMandateBody.safeParse(raw);
      if (!parsed.success) {
        const i = parsed.error.issues[0]!;
        return fail(400, `Invalid ${i.path.join(".") || "body"}: ${i.message}`);
      }
      return json(core.createMandate(parsed.data), 201);
    }

    if ((m = path.match(/^\/api\/mandates\/([^/]+)$/))) {
      const bad = allow("GET");
      if (bad) return bad;
      const mandate = core.getMandate(decodeURIComponent(m[1]!));
      return mandate ? json(mandate) : fail(404, "Mandate not found");
    }

    if ((m = path.match(/^\/api\/mandates\/([^/]+)\/revoke$/))) {
      const bad = allow("POST");
      if (bad) return bad;
      return json(core.revokeMandate(decodeURIComponent(m[1]!)));
    }

    if (path === "/api/payments") {
      const bad = allow("GET");
      if (bad) return bad;
      return json(core.listPayments(mandateId));
    }

    if ((m = path.match(/^\/api\/payments\/([^/]+)\/(approve|deny)$/))) {
      const bad = allow("POST");
      if (bad) return bad;
      const id = decodeURIComponent(m[1]!);
      return json(m[2] === "approve" ? await core.approvePayment(id) : core.denyPayment(id));
    }

    if (path === "/api/stats") {
      const bad = allow("GET");
      if (bad) return bad;
      return json(core.stats(mandateId));
    }

    return fail(404, "Not found");
  } catch (err) {
    if (err instanceof CoreError) return fail(err.kind === "not_found" ? 404 : 409, err.message);
    console.error("api error:", err);
    return fail(500, "Internal error");
  }
}
