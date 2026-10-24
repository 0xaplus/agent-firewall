import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Core, Payment } from "../types";

// The agent sees three tools and nothing that can read or edit a mandate's rules.
const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError } : {}),
});

function describePayment(p: Payment) {
  const reasons = p.checks.filter((c) => !c.pass).map((c) => c.reason);
  return {
    paymentId: p.id,
    verdict: p.verdict,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    reasons,
    ...(p.reference ? { reference: p.reference } : {}),
    ...(p.receiptUrl ? { receiptUrl: p.receiptUrl } : {}),
    ...(p.verdict === "needs_approval"
      ? {
          next: "A human must approve this payment. Check get_payment_status later; do not retry.",
        }
      : {}),
  };
}

// One server per request, bound to the mandate the Bearer token maps to.
export function createMcpServer(core: Core, mandateId: string): McpServer {
  const server = new McpServer({ name: "agent-firewall", version: "0.1.0" });

  server.registerTool(
    "request_payment",
    {
      description:
        "Ask the agent firewall to make a payment. Returns a verdict (approved, needs_approval or blocked) " +
        "with the reasons. Amounts are in the mandate's currency.",
      inputSchema: {
        amount: z
          .number()
          .positive()
          .describe("Amount in the mandate's currency"),
        recipient: z
          .string()
          .min(1)
          .describe("Recipient address exactly as given on the invoice"),
        purpose: z.string().min(1).describe("Why this payment is being made"),
        currency: z
          .string()
          .optional()
          .describe("Optional; must equal the mandate currency if given"),
        context: z
          .string()
          .optional()
          .describe("The content you were acting on (invoice, email)"),
      },
    },
    async (args) => {
      try {
        return text(
          describePayment(await core.requestPayment(mandateId, args)),
        );
      } catch (err) {
        console.error("request_payment failed:", err);
        return text({ error: "Payment request failed" }, true);
      }
    },
  );

  server.registerTool(
    "get_payment_status",
    {
      description: "Check the status of a payment you requested.",
      inputSchema: { paymentId: z.string().min(1) },
    },
    async ({ paymentId }) => {
      const p = core.getPayment(paymentId);
      if (!p || p.mandateId !== mandateId)
        return text({ error: "Payment not found" }, true);
      return text(describePayment(p));
    },
  );

  server.registerTool(
    "get_spending_limits",
    {
      description:
        "See how much budget is left, the auto-approve threshold and who you may pay.",
    },
    async () => {
      try {
        const l = core.getLimits(mandateId);
        return text({
          currency: l.currency,
          remainingMonthlyBudget: l.remaining,
          autoApproveMax: l.autoApproveMax,
          allowedRecipients: l.allowedRecipients.map((r) => r.label),
        });
      } catch (err) {
        console.error("get_spending_limits failed:", err);
        return text({ error: "Could not read limits" }, true);
      }
    },
  );

  return server;
}

export async function handleMcp(req: Request, core: Core): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const mandate = token ? core.mandateForToken(token) : null;
  if (!mandate) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  // Stateless: no session ids, plain JSON responses.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(core, mandate.id);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
