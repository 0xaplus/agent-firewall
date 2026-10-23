import { describe, expect, test } from "bun:test";

const html = await Bun.file("public/index.html").text();

describe("dashboard page", () => {
  test("is one self-contained file: no external scripts, styles or build step", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
  });
  test("never hardcodes a currency or an address format", () => {
    expect(html).not.toMatch(/USDC|USD\b|NGN|EUR/);
    expect(html).not.toMatch(/0x[0-9a-f]{4,}/i);
  });
  test("renders agent-controlled text without innerHTML", () => {
    expect(html).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
  test("polls the API every 2s and scrubs the token from the URL", () => {
    expect(html).toMatch(/setInterval\(refresh,\s*2000\)/);
    expect(html).toMatch(/history\.replaceState/);
  });
});
