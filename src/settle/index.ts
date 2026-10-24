import type { Settler } from "../types";
import { createMockSettler } from "./mock";
import { createPayfromSettler } from "./payfrom";

// Chosen by the SETTLER env var; mock unless told otherwise.
export function createSettler(name = process.env.SETTLER?.trim() ?? "mock"): Settler {
  switch (name) {
    case "mock": return createMockSettler();
    case "payfrom": {
      // Fail at boot, not at first payment: a rail configured without keys must not boot.
      const missing = ["PAYFROM_API_KEY", "PAYFROM_WALLET_ID"].filter((k) => !process.env[k]?.trim());
      if (missing.length) throw new Error(`SETTLER=payfrom needs ${missing.join(" and ")} (a funded PayFrom wallet: dashboard.payfrom.co)`);
      return createPayfromSettler({
        apiKey: process.env.PAYFROM_API_KEY!.trim(),
        walletId: process.env.PAYFROM_WALLET_ID!.trim(),
        ...(process.env.PAYFROM_ASSET_KEY?.trim() ? { assetKey: process.env.PAYFROM_ASSET_KEY.trim() } : {}),
      });
    }
    default:
      throw new Error(`Unknown SETTLER "${name}" (expected mock or payfrom)`);
  }
}
