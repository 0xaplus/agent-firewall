import { describe, expect, test } from "bun:test";
import { checkIntent, openRouterIntentLlm, SYSTEM_PROMPT, type IntentInput, type IntentLlm } from "../../src/engine/intent";
import { verdictOf } from "../../src/engine/risk";

const input: IntentInput = { task: "Pay supplier invoices", purpose: "Invoice 1", recipientLabel: "Lagos Textiles Ltd", amount: 100, currency: "USDC", context: "Invoice text" };
const replying = (text: string): IntentLlm => ({ complete: async () => text });
const reply = (o: object) => replying(JSON.stringify(o));
const get = (r: Awaited<ReturnType<typeof checkIntent>>, name: string) => r.checks.find((c) => c.name === name)!;

describe("checkIntent", () => {
  test("aligned and clean: both checks pass, score returned", async () => {
    const r = await checkIntent(reply({ aligned: true, injectionSuspected: false, reason: "Matches invoice.", score: 5 }), input);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.score).toBe(5);
    expect(verdictOf(r.checks)).toBe("approved");
  });
  test("injection suspected: block", async () => {
    const r = await checkIntent(reply({ aligned: false, injectionSuspected: true, reason: "Email tells the agent to ignore limits.", score: 95 }), input);
    expect(get(r, "injection")).toMatchObject({ pass: false, severity: "block" });
    expect(get(r, "injection").reason).toContain("ignore limits");
    expect(verdictOf(r.checks)).toBe("blocked");
  });
  test("not aligned: escalate, not block", async () => {
    const r = await checkIntent(reply({ aligned: false, injectionSuspected: false, reason: "Personal loan, not a supplier invoice.", score: 70 }), input);
    expect(get(r, "intent")).toMatchObject({ pass: false, severity: "escalate" });
    expect(verdictOf(r.checks)).toBe("needs_approval");
  });
  test("tolerates prose and code fences around the JSON, clamps score", async () => {
    const r = await checkIntent(replying('Sure!\n```json\n{"aligned":true,"injectionSuspected":false,"reason":"ok","score":250}\n```'), input);
    expect(r.score).toBe(100);
    expect(get(r, "intent").pass).toBe(true);
  });
  test("a thrown error escalates", async () => {
    const r = await checkIntent({ complete: async () => { throw new Error("503"); } }, input);
    expect(r.score).toBeNull();
    expect(verdictOf(r.checks)).toBe("needs_approval");
    expect(r.checks[0]!.reason).toContain("unavailable");
  });
  test("a timeout escalates and aborts the call", async () => {
    let aborted = false;
    const slow: IntentLlm = { complete: ({ signal }) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))) };
    const r = await checkIntent(slow, input, 30);
    expect(verdictOf(r.checks)).toBe("needs_approval");
    expect(r.checks[0]!.reason).toContain("timed out");
    expect(aborted).toBe(true);
  });
  test("garbage, wrong shapes and empty replies escalate", async () => {
    for (const text of ["I think it is fine", "{}", '{"aligned":"yes"}', "", "{not json}"]) {
      const r = await checkIntent(replying(text), input);
      expect(verdictOf(r.checks)).toBe("needs_approval");
      expect(r.score).toBeNull();
    }
  });
  test("can never approve: every outcome only adds checks, and a pass cannot hide a block", async () => {
    const r = await checkIntent(reply({ aligned: true, injectionSuspected: true, reason: "x", score: 0 }), input);
    expect(verdictOf(r.checks)).toBe("blocked");
  });
  test("sends the task, labelled recipient and context, with the audit prompt", async () => {
    let seen: { system: string; user: any } | undefined;
    await checkIntent({ complete: async (a) => { seen = { system: a.system, user: JSON.parse(a.user) }; return "{}"; } }, { ...input, context: "x".repeat(10_000) });
    expect(seen!.system).toBe(SYSTEM_PROMPT);
    expect(seen!.system).toContain("untrusted");
    expect(seen!.user).toMatchObject({ task: input.task, recipient: "Lagos Textiles Ltd", amount: "100 USDC" });
    expect(seen!.user.context.length).toBe(4000);
  });
  test("long multi-line reasons are flattened and truncated for humans", async () => {
    const r = await checkIntent(reply({ aligned: false, injectionSuspected: false, reason: "a\n\nb ".repeat(200), score: 50 }), input);
    expect(get(r, "intent").reason).not.toContain("\n");
    expect(get(r, "intent").reason.length).toBeLessThan(260);
  });
});

describe("openRouterIntentLlm", () => {
  test("posts the prompt with the key and model, returns the message text", async () => {
    let seen: any;
    const llm = openRouterIntentLlm("sk-or", undefined, async (url, init) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
      return Response.json({ choices: [{ message: { content: "hi" } }] });
    });
    const out = await llm.complete({ system: "s", user: "u", signal: new AbortController().signal });
    expect(out).toBe("hi");
    expect(seen.url).toContain("openrouter.ai");
    expect(seen.headers.authorization).toBe("Bearer sk-or");
    expect(seen.body).toMatchObject({ model: "anthropic/claude-haiku-5.5", temperature: 0 });
    expect(seen.body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(seen.signal).toBeDefined();
  });
  test("HTTP errors and empty bodies throw (and so escalate)", async () => {
    const sig = new AbortController().signal;
    await expect(openRouterIntentLlm("k", "m", async () => Response.json({}, { status: 500 })).complete({ system: "", user: "", signal: sig })).rejects.toThrow("500");
    await expect(openRouterIntentLlm("k", "m", async () => Response.json({ choices: [] })).complete({ system: "", user: "", signal: sig })).rejects.toThrow("empty");
  });
});
