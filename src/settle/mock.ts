import type { Settler } from "../types";

// Supports every currency and rail. Idempotent on paymentId: the reference is derived from it.
export function createMockSettler(): Settler {
  const sent = new Map<string, { reference: string; receiptUrl?: string }>();
  return {
    name: "mock",
    supports: () => true,
    async send(p) {
      const prior = sent.get(p.paymentId);
      if (prior) return prior;
      const hash = new Bun.CryptoHasher("sha256").update(p.paymentId).digest("hex");
      const result = { reference: `mock_${hash.slice(0, 24)}` };
      sent.set(p.paymentId, result);
      return result;
    },
  };
}
