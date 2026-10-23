import { describe, expect, test } from "bun:test";
import {
  allowlist, amountValid, anomaly, autoApprove, cumulative, currency, duplicate, hardMax, mandateActive, monthlyCap,
  runRules, velocity, type RuleCtx,
} from "../../src/engine/rules";
import { DEMO_MANDATE } from "../../src/fixtures";
import type { Payment, PaymentRequest } from "../../src/types";

const LAGOS = DEMO_MANDATE.allowlist[0]!.address;
const NOW = new Date("2026-10-15T12:00:00Z");
const ctx = (over: Partial<Omit<RuleCtx, "req">> & { req?: Partial<PaymentRequest> } = {}): RuleCtx => ({
  mandate: DEMO_MANDATE, monthSpend: 0, recent: [], history: [], now: NOW, ...over,
  req: { amount: 100, recipient: LAGOS, purpose: "x", ...over.req },
});
const past = (over: Partial<Payment> = {}): Payment => ({
  id: "p", mandateId: DEMO_MANDATE.id, amount: 50, currency: "USDC", recipient: LAGOS, purpose: "x",
  verdict: "approved", status: "settled", risk: 0, checks: [], createdAt: NOW.toISOString(), ...over,
});

describe("amount_valid", () => {
  test("passes a positive amount", () => expect(amountValid(ctx()).pass).toBe(true));
  test("blocks zero, negative, NaN and Infinity", () => {
    for (const amount of [0, -5, NaN, Infinity]) {
      const c = amountValid(ctx({ req: { amount } }));
      expect([c.pass, c.severity]).toEqual([false, "block"]);
    }
  });
});

describe("R0 currency", () => {
  test("passes when omitted or equal", () => {
    expect(currency(ctx()).pass).toBe(true);
    expect(currency(ctx({ req: { currency: "USDC" } })).pass).toBe(true);
  });
  test("blocks a different currency", () => {
    const c = currency(ctx({ req: { currency: "EUR" } }));
    expect([c.pass, c.severity]).toEqual([false, "block"]);
    expect(c.reason).toContain("EUR");
  });
});

describe("R1 mandate active", () => {
  test("passes when active, unexpired or no expiry", () => {
    expect(mandateActive(ctx()).pass).toBe(true);
    expect(mandateActive(ctx({ mandate: { ...DEMO_MANDATE, expiresAt: "2027-01-01T00:00:00Z" } })).pass).toBe(true);
  });
  test("blocks revoked, expired and unparseable expiry", () => {
    expect(mandateActive(ctx({ mandate: { ...DEMO_MANDATE, status: "revoked" } })).reason).toContain("revoked");
    expect(mandateActive(ctx({ mandate: { ...DEMO_MANDATE, expiresAt: "2026-10-01T00:00:00Z" } })).pass).toBe(false);
    expect(mandateActive(ctx({ mandate: { ...DEMO_MANDATE, expiresAt: "garbage" } })).pass).toBe(false);
  });
});

describe("R2 allowlist", () => {
  test("passes a listed recipient and names it", () => expect(allowlist(ctx()).reason).toContain("Lagos Textiles"));
  test("blocks unknown, lookalike and whitespace-padded addresses", () => {
    for (const recipient of ["0x9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f", LAGOS.slice(0, 20) + "f" + LAGOS.slice(21), LAGOS + " ", LAGOS.toUpperCase()]) {
      const c = allowlist(ctx({ req: { recipient } }));
      expect([c.pass, c.severity]).toEqual([false, "block"]);
    }
    expect(allowlist(ctx({ req: { recipient: "0x9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f" } })).reason).toBe("Recipient 0x9f9f…9f9f is not on the allowlist.");
  });
});

describe("R3 hard max", () => {
  test("passes at the limit", () => expect(hardMax(ctx({ req: { amount: 1000 } })).pass).toBe(true));
  test("blocks above it", () => {
    const c = hardMax(ctx({ req: { amount: 1000.01 } }));
    expect([c.pass, c.severity]).toEqual([false, "block"]);
  });
});

describe("R4 monthly cap", () => {
  test("passes when spend plus amount hits the cap exactly", () => expect(monthlyCap(ctx({ monthSpend: 1900 })).pass).toBe(true));
  test("blocks when it would exceed the cap, and says how much is left", () => {
    const c = monthlyCap(ctx({ monthSpend: 1950 }));
    expect([c.pass, c.severity]).toEqual([false, "block"]);
    expect(c.reason).toContain("50 USDC left");
  });
});

describe("R5 auto-approve", () => {
  test("passes at the limit", () => expect(autoApprove(ctx({ req: { amount: 200 } })).pass).toBe(true));
  test("escalates above it", () => {
    const c = autoApprove(ctx({ req: { amount: 201 } }));
    expect([c.pass, c.severity]).toEqual([false, "escalate"]);
  });
});

describe("R6 velocity", () => {
  test("passes with 4 recent requests", () => expect(velocity(ctx({ recent: Array(4).fill(past()) })).pass).toBe(true));
  test("escalates when 5 are already in the window, blocked ones included", () => {
    const c = velocity(ctx({ recent: Array(5).fill(past({ verdict: "blocked", status: "blocked" })) }));
    expect([c.pass, c.severity]).toEqual([false, "escalate"]);
  });
});

describe("R7 anomaly", () => {
  test("passes with fewer than 3 history entries, however large", () =>
    expect(anomaly(ctx({ history: [10, 10], req: { amount: 900 } })).pass).toBe(true));
  test("passes at exactly 5× the median", () => expect(anomaly(ctx({ history: [10, 20, 30], req: { amount: 100 } })).pass).toBe(true));
  test("escalates above 5× the median (even-length median too)", () => {
    const c = anomaly(ctx({ history: [10, 10, 20, 20], req: { amount: 76 } })); // median 15 → limit 75
    expect([c.pass, c.severity]).toEqual([false, "escalate"]);
  });
});

describe("R8 duplicate", () => {
  test("passes with a different amount or recipient", () => {
    expect(duplicate(ctx({ recent: [past({ amount: 99 })] })).pass).toBe(true);
    expect(duplicate(ctx({ recent: [past({ amount: 100, recipient: "other" })] })).pass).toBe(true);
  });
  test("ignores earlier blocked, denied and failed requests", () => {
    expect(duplicate(ctx({ recent: [past({ amount: 100, verdict: "blocked", status: "blocked" }), past({ amount: 100, status: "denied" }), past({ amount: 100, status: "failed" })] })).pass).toBe(true);
  });
  test("escalates the same amount to the same recipient", () => {
    const c = duplicate(ctx({ recent: [past({ amount: 100 })] }));
    expect([c.pass, c.severity]).toEqual([false, "escalate"]);
  });
});

describe("R9 cumulative to one recipient", () => {
  test("passes when the running total stays under the auto-approve limit", () =>
    expect(cumulative(ctx({ req: { amount: 100 }, recent: [past({ amount: 100 })] })).pass).toBe(true));
  test("ignores other recipients and blocked requests", () =>
    expect(cumulative(ctx({ req: { amount: 150 }, recent: [past({ amount: 150, recipient: "other" }), past({ amount: 150, verdict: "blocked", status: "blocked" })] })).pass).toBe(true));
  test("escalates a split payment", () => {
    const c = cumulative(ctx({ req: { amount: 190 }, recent: [past({ amount: 190 })] }));
    expect([c.pass, c.severity]).toEqual([false, "escalate"]);
    expect(c.reason).toContain("190 USDC already requested");
  });
});

describe("runRules", () => {
  test("a clean request passes every rule", () => {
    const checks = runRules(ctx());
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks.length).toBe(11);
  });
  test("every check has a name and a non-empty reason, pass or fail", () => {
    for (const c of [...runRules(ctx()), ...runRules(ctx({ req: { amount: 5000, recipient: "0xevil", currency: "EUR" }, monthSpend: 2000 }))]) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});
