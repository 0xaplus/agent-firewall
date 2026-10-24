import { describe, expect, test } from "bun:test";
import { createSettler } from "../../src/settle";
import { createMockSettler } from "../../src/settle/mock";
import { createPayfromSettler, type PayfromDeps } from "../../src/settle/payfrom";

const send = (id: string, over: object = {}) => ({ paymentId: id, amount: 10, currency: "USDC", recipient: "0xabc", ...over });

describe("mock settler", () => {
  test("supports any currency", () => {
    const s = createMockSettler();
    expect([s.name, s.supports("USDC"), s.supports("NGN"), s.supports("anything")]).toEqual(["mock", true, true, true]);
  });
  test("returns a reference", async () => {
    expect((await createMockSettler().send(send("pay_1"))).reference).toMatch(/^mock_[0-9a-f]{24}$/);
  });
  test("same paymentId twice is the same transfer; different ids differ", async () => {
    const s = createMockSettler();
    const a = await s.send(send("pay_1"));
    expect(await s.send(send("pay_1", { amount: 999 }))).toEqual(a);
    expect((await s.send(send("pay_2"))).reference).not.toBe(a.reference);
    expect((await createMockSettler().send(send("pay_1"))).reference).toBe(a.reference); // survives a restart
  });
});

describe("payfrom settler", () => {
  const deps = (fetch: PayfromDeps["doFetch"], over: Partial<PayfromDeps> = {}): PayfromDeps => ({
    apiKey: "sk_test_...", walletId: "w_1", baseUrl: "https://api.payfrom.test",
    doFetch: fetch, pollIntervalMs: 1, maxPollMs: 50, timeoutMs: 1000, ...over,
  });
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const broadcasted = () => res(200, { success: true, data: { id: "tx_1", status: "BROADCASTED", txHash: "0xdead", reference: "pay_1" } });
  const statusOf = (s: string) => res(200, { success: true, data: { id: "tx_1", status: s, txHash: "0xdead", reference: "pay_1" } });
  const okListOld = () => res(200, { success: true, data: [{ id: "tx_old", status: "CONFIRMED", txHash: "0xold", reference: "pay_1", type: "TRANSFER", direction: "OUT" }] });

  // A scripted fake of the PayFrom API: replies are consumed in order; once the script runs
  // out, its last reply repeats (good enough for a poll loop that would spin on it).
  const script = (log: { url: string; init: RequestInit }[], replies: ((url: string) => Response)[]): typeof fetch => {
    let i = 0;
    return (async (url: string | URL, init: RequestInit = {}) => {
      log.push({ url: String(url), init });
      return replies[Math.min(i++, replies.length - 1)]!(String(url));
    }) as unknown as typeof fetch;
  };

  test("supports USDC only", () => {
    const s = createPayfromSettler(deps(script([], [() => res(200, { success: false, code: "resource_not_found", message: "nope" })])));
    expect([s.name, s.supports("USDC"), s.supports("NGN")]).toEqual(["payfrom", true, false]);
  });

  test("posts a decimal-string transfer to the wallet's transfers, with the paymentId as reference", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const s = createPayfromSettler(deps(script(log, [
      () => broadcasted(),
      () => statusOf("CONFIRMED"),
    ])));
    const out = await s.send(send("pay_1", { amount: 10.5, recipient: "0xabc" }));
    expect(out).toEqual({ reference: "0xdead", receiptUrl: "https://sepolia.basescan.org/tx/0xdead" });
    expect(log).toHaveLength(2);
    expect(log[0]!.url).toBe("https://api.payfrom.test/v1/wallets/w_1/transfers");
    expect(log[0]!.init.method).toBe("POST");
    expect(log[0]!.init.headers).toMatchObject({ authorization: "Bearer sk_test_..." });
    expect(JSON.parse(String(log[0]!.init.body))).toEqual({
      assetKey: "base-sepolia:usdc", amount: "10.5", address: "0xabc", reference: "pay_1",
    });
  });

  test("sends amounts at USDC's six decimals, without trailing zeros", async () => {
    const amountFor = async (amount: number) => {
      const log: { url: string; init: RequestInit }[] = [];
      await createPayfromSettler(deps(script(log, [() => broadcasted(), () => statusOf("CONFIRMED")]))).send(send("pay_1", { amount }));
      return JSON.parse(String(log[0]!.init.body)).amount;
    };
    expect([await amountFor(10), await amountFor(10.123456), await amountFor(0.1234567)]).toEqual(["10", "10.123456", "0.123457"]);
  });

  test("builds a receipt link for a known chain and none for an unknown one", async () => {
    const once = createPayfromSettler(deps(script([], [() => broadcasted(), () => statusOf("CONFIRMED")])));
    expect((await once.send(send("pay_1"))).receiptUrl).toBe("https://sepolia.basescan.org/tx/0xdead");
    const other = createPayfromSettler({
      ...deps(script([], [() => broadcasted(), () => statusOf("CONFIRMED")])),
      assetKey: "solana:usdc",
    });
    expect((await other.send(send("pay_1"))).receiptUrl).toBeUndefined();
  });

  test("polls the transaction until CONFIRMED", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const s = createPayfromSettler(deps(script(log, [
      () => broadcasted(),
      () => statusOf("PROCESSING"),
      () => statusOf("CONFIRMED"),
    ])));
    expect((await s.send(send("pay_1"))).reference).toBe("0xdead");
    expect(log).toHaveLength(3);
  });

  test("an on-chain FAILED transfer is a settlement error", async () => {
    const s = createPayfromSettler(deps(script([], [
      () => broadcasted(),
      () => statusOf("FAILED"),
    ])));
    await expect(s.send(send("pay_1"))).rejects.toThrow(/failed/);
  });

  test("a transfer without a txHash is a settlement error, not a guess", async () => {
    const s = createPayfromSettler(deps(script([], [
      () => res(200, { success: true, data: { id: "tx_1", status: "BROADCASTED" } }),
    ])));
    await expect(s.send(send("pay_1"))).rejects.toThrow(/no txHash/);
  });

  test("insufficient balance is rejected outright, never retried", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const s = createPayfromSettler(deps(script(log, [
      () => res(400, { success: false, code: "insufficient_balance", message: "Insufficient token balance to cover the amount plus the network fee" }),
    ])));
    await expect(s.send(send("pay_1"))).rejects.toThrow(/Insufficient token balance/);
    expect(log).toHaveLength(1);
  });

  test("a refusal without PayFrom's JSON error keeps the reply, so the cause is visible", async () => {
    const s = createPayfromSettler(deps(script([], [
      () => new Response("<html><body><h1>403 Forbidden</h1> Request blocked by firewall</body></html>", { status: 403 }),
    ])));
    await expect(s.send(send("pay_1"))).rejects.toThrow(/Payfrom 403: 403 Forbidden Request blocked by firewall/);
  });

  test("a transient failure (network_error) creates on the second attempt", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const s = createPayfromSettler(deps(script(log, [
      () => res(200, { success: false, code: "network_error", message: "A transient RPC/network condition" }),
      () => broadcasted(),
      () => statusOf("CONFIRMED"),
    ])));
    expect((await s.send(send("pay_1"))).reference).toBe("0xdead");
    expect(log.filter((l) => l.init.method === "POST")).toHaveLength(2);
  });

  test("a dropped connection is retried once", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const s = createPayfromSettler(deps(script(log, [
      () => { throw new Error("offline"); },
      () => broadcasted(),
      () => statusOf("CONFIRMED"),
    ])));
    expect((await s.send(send("pay_1"))).reference).toBe("0xdead");
    expect(log.filter((l) => l.init.method === "POST")).toHaveLength(2);
  });

  test("two transient failures give up with one clear error", async () => {
    const s = createPayfromSettler(deps(script([], [
      () => { throw new Error("offline"); },
      () => { throw new Error("offline"); },
    ])));
    await expect(s.send(send("pay_1"))).rejects.toThrow(/Payfrom rejected the transfer/);
  });

  test("a reference conflict means the old transfer wins: look it up instead of failing", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const s = createPayfromSettler(deps(script(log, [
      () => res(409, { success: false, code: "resource_conflict", message: "Transfer with reference pay_1 already exists" }),
      () => okListOld(),
      () => statusOf("CONFIRMED"),
    ])));
    expect((await s.send(send("pay_1"))).reference).toBe("0xold");
    expect(log.some((l) => l.url.includes("/transactions?"))).toBe(true);
  });
});

describe("createSettler", () => {
  test("defaults to mock", () => expect(env({ SETTLER: undefined }, () => createSettler().name)).toBe("mock"));
  test("payfrom without credentials refuses to boot", () =>
    expect(() => env({ SETTLER: "payfrom", PAYFROM_API_KEY: undefined, PAYFROM_WALLET_ID: undefined }, () => createSettler("payfrom")))
      .toThrow(/needs PAYFROM/));
  test("payfrom with credentials builds the USDC settler", () =>
    expect(env({ SETTLER: "payfrom", PAYFROM_API_KEY: "sk_test_x", PAYFROM_WALLET_ID: "w_1" }, () => createSettler().name)).toBe("payfrom"));
  test("unknown names are rejected", () => expect(() => createSettler("stripe")).toThrow(/Unknown SETTLER/));

  // Runs fn with those env values set (undefined removes the key), then restores.
  function env(give: Record<string, string | undefined>, fn: () => unknown): unknown {
    const put = (vals: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(vals)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    };
    const before = Object.fromEntries(Object.keys(give).map((k) => [k, process.env[k]]));
    put(give);
    try { return fn(); } finally { put(before); }
  }
});
