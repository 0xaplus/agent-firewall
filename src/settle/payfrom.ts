// Payfrom settler: sends a real on-chain USDC transfer from the merchant's PayFrom wallet.
// Contract: https://docs.payfrom.co (concepts, wallets#create-transfer, errors).
//
// Lifecycle notes: a transfer is asynchronous — the POST returns BROADCASTED with a txHash, and the
// transfer later reaches CONFIRMED or FAILED. We poll the retrieve endpoint for a bounded time.
// Amounts go over the wire as decimal strings; the reference field is the idempotency key, so a
// retried POST can never create a second transfer.
import type { Settler } from "../types";

// Retry only what PayFrom itself documents as transient: a failed connection, or these codes.
const TRANSIENT = new Set(["network_error", "sponsorship_unavailable"]);

export const DEFAULT_ASSET_KEY = "base-sepolia:usdc"; // USDC on Base Sepolia (test env)

// Build a receipt link from the chain's explorer when we know it (GET /v1/chains lists explorerUrl).
const EXPLORERS: Record<string, string> = {
  "base-sepolia": "https://sepolia.basescan.org/tx/",
  "ethereum-sepolia": "https://sepolia.etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  ethereum: "https://etherscan.io/tx/",
  bsc: "https://bscscan.com/tx/",
  polygon: "https://polygonscan.com/tx/",
};

export interface PayfromDeps {
  apiKey: string;
  walletId: string;               // the merchant wallet transfers leave from (must be funded)
  assetKey?: string;              // "<chainKey>:usdc", default USDC on Base Sepolia
  baseUrl?: string;
  doFetch?: typeof fetch;         // injectable for tests; never call the real rail in tests
  timeoutMs?: number;             // per-request timeout
  pollIntervalMs?: number;        // how often to wait between status checks
  maxPollMs?: number;             // give up waiting, treat BROADCASTED-with-txHash as settled
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The start of a reply body on one line, for error messages and logs.
const snippet = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

export function createPayfromSettler({
  apiKey,
  walletId,
  assetKey = DEFAULT_ASSET_KEY,
  baseUrl = process.env.PAYFROM_BASE_URL?.trim() || "https://api.payfrom.co",
  doFetch = fetch,
  timeoutMs = 15_000,
  pollIntervalMs = 2_000,
  maxPollMs = 25_000,
}: PayfromDeps): Settler {
  const settler: Settler = {
    name: "payfrom",
    // USDC-only for now (PLAN.md: the demo rail). Widen here when more rails exist.
    supports: (currency) => currency === "USDC",

    async send(p) {
      // Mandate amounts are numbers; the rail wants an exact decimal string. Six decimals
      // (USDC) is enough resolution; any mandate amount rounds cleanly there.
      const amount = p.amount.toFixed(6).replace(/\.?0+$/, "") || "0";
      // POST creates and broadcasts. A retried POST can never pay twice: the reference
      // (paymentId) makes a repeat a 409 conflict, which we resolve against the old transfer.
      const posted = await attempt();
      if (!posted.ok)
        throw new Error(`Payfrom rejected the transfer: ${posted.error}`);
      const tx = posted.data;
      if (!tx.txHash) throw new Error("Payfrom accepted the transfer but returned no txHash");
      const receiptUrl = receiptFor(assetKey, tx.txHash);

      // Poll until CONFIRMED or FAILED. Past the deadline we still settle: the transfer is
      // broadcast and the funds left the wallet (post-broadcast failure is rare), so claiming
      // failure would be false, and leaving it settling would strand the payment forever.
      const deadline = Date.now() + maxPollMs;
      while (Date.now() < deadline) {
        if (await isTerminal(tx.id)) break;
        await sleep(Math.max(1, pollIntervalMs));
      }

      async function isTerminal(txId: string): Promise<boolean> {
        const res = (await call("GET", `/v1/wallets/${walletId}/transactions/${txId}`));
        if (!res.ok) return false; // transient lookups fail open; the poll continues
        if (res.data.status === "CONFIRMED") return true;
        if (res.data.status === "FAILED") throw new Error(`Payfrom transfer failed on-chain: ${res.data.failureReason ?? tx.txHash}`);
        return false;
      }
      return { reference: tx.txHash, ...(receiptUrl ? { receiptUrl } : {}) };

      // One create call, with a single retry when the failure is transient. A retry that hits
      // an already-created reference is resolved by looking the transfer up, not failing.
      async function attempt(): Promise<{ ok: true; data: { id: string; txHash?: string; status: string } } | { ok: false; error: string }> {
        let err = "";
        for (let tries = 0; tries < 2; tries++) {
          if (tries) await sleep(400);
          const out = await call("POST", `/v1/wallets/${walletId}/transfers`, {
            assetKey, amount, address: p.recipient, reference: p.paymentId,
          });
          if (out.ok) return { ok: true, data: out.data };
          if (out.code === "resource_conflict") {
            // A reference conflict means an earlier attempt already created this transfer: the
            // funds are spoken for. Recover the old transfer instead of failing the payment.
            const old = await findByReference(p.paymentId);
            if (old) return { ok: true, data: old };
            return { ok: false, error: `Payfrom already has a transfer with reference ${p.paymentId}, but it could not be found` };
          }
          err = out.error;
          if (!TRANSIENT.has(out.code)) break;
        }
        return { ok: false, error: err };
      }
    },
  };
  return settler;

  function findByReference(reference: string): Promise<{ id: string; txHash?: string; status: string } | null> {
    return call("GET", `/v1/wallets/${walletId}/transactions?limit=100`).then((out) =>
      out.ok ? ((out.data as any[]) ?? []).find?.((t) => t.reference === reference && t.type === "TRANSFER" && t.direction === "OUT") ?? null : null,
    );
  }

  function receiptFor(asset: string, txHash: string): string | undefined {
    const base = EXPLORERS[asset.split(":")[0]!];
    return base ? `${base}${txHash}` : undefined;
  }

  // Auth'ed JSON call; returns a normalised result and never throws for the caller.
  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<
    { ok: true; data: any } | { ok: false; status: number; code: string; error: string }
  > {
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => "");
      let json: any = {};
      try { json = JSON.parse(text); } catch { /* not JSON: a proxy or firewall page, say */ }
      const data = json?.success ? json.data : undefined;
      if (!res.ok || json?.success === false) {
        // Keep what came back, so a refusal from something in front of PayFrom is visible too.
        const error = json?.message ?? `Payfrom ${res.status}: ${snippet(text) || "(empty reply)"}`;
        console.error(`payfrom ${method} ${path} -> ${res.status} ${json?.code ?? ""}: ${snippet(text)}`);
        return { ok: false, status: res.status, code: json?.code ?? "", error };
      }
      if (data === undefined) return { ok: false, status: res.status, code: "bad_reply", error: `Payfrom reply is unreadable: ${snippet(text)}` };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, status: 0, code: "network_error", error: `Payfrom unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
