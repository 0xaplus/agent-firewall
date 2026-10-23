import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "../../src/api";
import { createFakeCore } from "../../src/core.fake";
import { DEMO_MANDATE } from "../../src/fixtures";
import type { Core } from "../../src/types";

const LAGOS = DEMO_MANDATE.allowlist[0]!.address;
const { id: _i, agentToken: _t, status: _s, ...NEW_MANDATE } = DEMO_MANDATE;

let core: Core;
let saved: string | undefined;
beforeEach(() => { core = createFakeCore(); saved = process.env.ADMIN_TOKEN; process.env.ADMIN_TOKEN = "test"; });
afterEach(() => { if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved; });

const call = (method: string, path: string, body?: unknown, token: string | null = "test") =>
  handleApi(new Request(`http://x${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), core);

const pay = (amount: number) => core.requestPayment(DEMO_MANDATE.id, { amount, recipient: LAGOS, purpose: "x" });

describe("auth", () => {
  test("missing or wrong token is 401", async () => {
    expect((await call("GET", "/api/stats", undefined, null)).status).toBe(401);
    expect((await call("GET", "/api/stats", undefined, "nope")).status).toBe(401);
  });
  test("unset ADMIN_TOKEN fails closed, even for 'Bearer undefined' and 'Bearer '", async () => {
    delete process.env.ADMIN_TOKEN;
    expect((await call("GET", "/api/stats", undefined, "test")).status).toBe(401);
    expect((await call("GET", "/api/stats", undefined, "undefined")).status).toBe(401);
    expect((await call("GET", "/api/stats", undefined, "")).status).toBe(401);
  });
  test("401 body is { error }", async () => {
    expect(await (await call("GET", "/api/stats", undefined, null)).json()).toEqual({ error: "Unauthorized" });
  });
});

describe("mandates", () => {
  test("POST creates a mandate with any currency and non-0x addresses", async () => {
    const res = await call("POST", "/api/mandates", {
      ...NEW_MANDATE, currency: "NGN", allowlist: [{ address: "NG12 3456 7890", label: "Bank A", category: "supplier" }],
    });
    expect(res.status).toBe(201);
    const m = await res.json() as any;
    expect(m.currency).toBe("NGN");
    expect(m.status).toBe("active");
    expect(m.agentToken).toStartWith("agt_");
    expect(core.getMandate(m.id)).not.toBeNull();
  });
  test("POST ignores caller-supplied id, token and status", async () => {
    const res = await call("POST", "/api/mandates", { ...NEW_MANDATE, id: "mdt_x", agentToken: "agt_x", status: "revoked" });
    const m = await res.json() as any;
    expect(m.id).not.toBe("mdt_x");
    expect(m.agentToken).not.toBe("agt_x");
    expect(m.status).toBe("active");
  });
  test("POST rejects bad input with 400 and { error }", async () => {
    for (const bad of [
      { ...NEW_MANDATE, currency: "" },
      { ...NEW_MANDATE, hardMax: "lots" },
      { ...NEW_MANDATE, monthlyCap: -1 },
      { ...NEW_MANDATE, allowlist: [{ address: "", label: "a", category: "b" }] },
      { name: "only a name" },
    ]) {
      const res = await call("POST", "/api/mandates", bad);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as any).error).toBe("string");
    }
  });
  test("POST with malformed JSON is 400", async () => {
    expect((await call("POST", "/api/mandates", "{nope")).status).toBe(400);
  });
  test("GET returns the mandate, 404 when unknown", async () => {
    const res = await call("GET", `/api/mandates/${DEMO_MANDATE.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBe(DEMO_MANDATE.id);
    expect((await call("GET", "/api/mandates/mdt_nope")).status).toBe(404);
  });
  test("revoke flips status; unknown id is 404", async () => {
    const res = await call("POST", `/api/mandates/${DEMO_MANDATE.id}/revoke`);
    expect(((await res.json()) as any).status).toBe("revoked");
    expect(core.getMandate(DEMO_MANDATE.id)?.status).toBe("revoked");
    expect((await call("POST", "/api/mandates/mdt_nope/revoke")).status).toBe(404);
  });
});

describe("payments", () => {
  test("list is newest first and filters by mandateId", async () => {
    const a = await pay(10);
    const b = await pay(20);
    const all = await (await call("GET", "/api/payments")).json() as any[];
    expect(all.map((p) => p.id)).toEqual([b.id, a.id]);
    const mine = await (await call("GET", `/api/payments?mandateId=${DEMO_MANDATE.id}`)).json() as any[];
    expect(mine).toHaveLength(2);
    expect(await (await call("GET", "/api/payments?mandateId=mdt_other")).json()).toEqual([]);
  });
  test("approve settles a pending payment", async () => {
    const p = await pay(500);
    const res = await call("POST", `/api/payments/${p.id}/approve`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("settled");
    expect(body.reference).toBeTruthy();
  });
  test("deny rejects a pending payment", async () => {
    const p = await pay(500);
    const res = await call("POST", `/api/payments/${p.id}/deny`);
    expect(((await res.json()) as any).status).toBe("denied");
  });
  test("approve/deny on a non-pending payment is 409", async () => {
    const settled = await pay(10);
    expect((await call("POST", `/api/payments/${settled.id}/approve`)).status).toBe(409);
    expect((await call("POST", `/api/payments/${settled.id}/deny`)).status).toBe(409);
    const p = await pay(500);
    await call("POST", `/api/payments/${p.id}/approve`);
    const again = await call("POST", `/api/payments/${p.id}/approve`);
    expect(again.status).toBe(409);
    expect(typeof ((await again.json()) as any).error).toBe("string");
  });
  test("approve/deny on an unknown payment is 404", async () => {
    expect((await call("POST", "/api/payments/pay_nope/approve")).status).toBe(404);
    expect((await call("POST", "/api/payments/pay_nope/deny")).status).toBe(404);
  });
});

describe("stats", () => {
  test("returns counts and amounts, optionally per mandate", async () => {
    await pay(10);
    await core.requestPayment(DEMO_MANDATE.id, { amount: 30, recipient: "0xdead", purpose: "x" });
    const stats = await (await call("GET", "/api/stats")).json() as any;
    expect(stats).toEqual({ total: 2, approved: 1, needsApproval: 0, blocked: 1, settledAmount: 10, blockedAmount: 30 });
    const none = await (await call("GET", "/api/stats?mandateId=mdt_other")).json() as any;
    expect(none.total).toBe(0);
  });
});

describe("routing", () => {
  test("wrong method is 405", async () => {
    expect((await call("GET", "/api/mandates")).status).toBe(405);
    expect((await call("POST", "/api/stats")).status).toBe(405);
    expect((await call("GET", "/api/payments/pay_x/approve")).status).toBe(405);
    expect((await call("DELETE", `/api/mandates/${DEMO_MANDATE.id}`)).status).toBe(405);
  });
  test("unknown route is 404 with { error }", async () => {
    const res = await call("GET", "/api/nothing");
    expect(res.status).toBe(404);
    expect(typeof ((await res.json()) as any).error).toBe("string");
  });
  test("a core that throws gives a 500 without leaking the message", async () => {
    const boom = { ...core, stats: () => { throw new Error("secret detail"); } } as Core;
    const res = await handleApi(new Request("http://x/api/stats", { headers: { authorization: "Bearer test" } }), boom);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
