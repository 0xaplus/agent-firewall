import type { Settler } from "../types";
import { createMockSettler } from "./mock";

// Chosen by the SETTLER env var; mock unless told otherwise.
export function createSettler(name = process.env.SETTLER ?? "mock"): Settler {
  switch (name) {
    case "mock": return createMockSettler();
    case "payfrom":
      throw new Error("SETTLER=payfrom is not implemented yet; use SETTLER=mock");
    default:
      throw new Error(`Unknown SETTLER "${name}" (expected mock or payfrom)`);
  }
}
