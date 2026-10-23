import { describe, expect, test } from "bun:test";
import { createSettler } from "../../src/settle";
import { createMockSettler } from "../../src/settle/mock";

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

describe("createSettler", () => {
  test("defaults to mock", () => expect(createSettler().name).toBe("mock"));
  test("payfrom is not available yet and says so", () => expect(() => createSettler("payfrom")).toThrow(/not implemented/));
  test("unknown names are rejected", () => expect(() => createSettler("stripe")).toThrow(/Unknown SETTLER/));
});
