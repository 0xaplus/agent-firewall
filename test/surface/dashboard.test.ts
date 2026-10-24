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
  test("polls the API every 2s, keeps the token in sessionStorage only and scrubs it from the URL", () => {
    expect(html).toMatch(/setInterval\(refresh,\s*2000\)/);
    expect(html).toMatch(/history\.replaceState/);
  });
  test("has the owner journey: create a mandate, connect an agent, try a request, approve, revoke", () => {
    for (const id of ["create", "connect", "tryit", "tryform", "msel", "new-btn", "pending", "feed"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("/api/mandates");
    expect(html).toContain("/revoke");
    expect(html).toContain("claude mcp add");
  });
  test("can draft the rules from plain English, and still needs Create to save them", () => {
    for (const id of ["rules-text", "draft-btn", "draft-notes"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("/api/mandates/draft");
    expect(html).toContain("Nothing is saved until you check it and press Create mandate.");
  });
  test("shows the budget warning text from the limits route, with a class for its level", () => {
    expect(html).toContain("/limits`");
    expect(html).toContain("budget ${b.level}");
  });
  test("shows whether the audit log verifies", () => {
    expect(html).toContain('id="audit"');
    expect(html).toContain("/api/audit/verify");
  });
  test("never sends the admin token anywhere but same-origin API calls", () => {
    expect(html).not.toMatch(/https?:\/\/(?!localhost|www\.w3\.org)/);
    expect(html).toContain("sessionStorage.setItem(TOKEN_KEY");
    expect(html).not.toMatch(/localStorage[^;]*TOKEN_KEY/);
  });
});
