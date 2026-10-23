import type { Llm } from "./agent";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

// The agent loop speaks Anthropic-style content blocks; OpenRouter speaks OpenAI chat completions.
export function toOpenAiMessages(system: string, messages: any[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      const calls = m.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result")
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: b.content,
          });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

export function openRouterLlm(
  apiKey: string,
  model = DEFAULT_MODEL,
  doFetch: (url: string, init: any) => Promise<Response> = fetch,
): Llm {
  return {
    async create({ system, tools, messages }) {
      const res = await doFetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: toOpenAiMessages(system, messages),
          tools: (tools as any[]).map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            },
          })),
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          `OpenRouter ${res.status}: ${body?.error?.message ?? "request failed"}`,
        );
      const msg = body.choices?.[0]?.message;
      if (!msg) throw new Error("OpenRouter returned no message");
      const content: any[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const c of msg.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          /* model sent bad JSON: call with no args */
        }
        content.push({
          type: "tool_use",
          id: c.id,
          name: c.function.name,
          input,
        });
      }
      return {
        content,
        stop_reason: msg.tool_calls?.length ? "tool_use" : "end_turn",
      };
    },
  };
}
