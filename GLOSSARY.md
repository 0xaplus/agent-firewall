# Glossary

The words this codebase uses for its domain. Code, tests, docs and the dashboard should use them the same way.

**Mandate**: the rules a human writes for one agent: what it is for (task), one currency, an auto-approve limit, a hard limit, a monthly cap, an allowlist and an optional expiry. Active or revoked. Rules can't be edited after creation; make a new mandate instead. _Code_: `Mandate` in `src/types.ts`.

**Agent token**: the Bearer token (`agt_…`) an agent sends to `/mcp`. One token belongs to one mandate. A revoked mandate's token is refused at once.

**Allowlist**: the recipients a mandate may pay. Each has an address (an opaque string: wallet, IBAN, account number) and a label. Addresses are compared exactly; only the agent ever sees labels, never addresses.

**Payment request**: what the agent asks for: amount, recipient address, purpose and optionally the content it was acting on (context). _Code_: `PaymentRequest`.

**Payment**: a payment request after the firewall has judged it, stored whatever the outcome. It has a verdict, a status, its checks and a risk score. _Code_: `Payment`.

**Check**: one test applied to a payment request, with a plain-English reason shown to humans. A failed check has a severity: *block* (the payment is blocked) or *escalate* (a human must decide). Rules R0–R9 and the intent check produce checks.

**Verdict**: the firewall's judgement of a request: *approved*, *needs_approval* or *blocked*. Any failed block check wins, then any failed escalate check. Set once, never changed.

**Status**: where a payment is in its life: *pending_approval*, *settling*, *settled*, *blocked*, *denied* or *failed*. Unlike the verdict, it changes over time.

**Payment lifecycle**: the module that owns every status change (`src/payments.ts`). It opens a judged payment, settles approved ones, and handles approve, deny, and deny-on-revoke. Moves outside its list of allowed moves are refused with a `wrong_state` error.

**Intent check**: the optional LLM audit that runs after the rules when nothing blocked. It treats the context as untrusted data. It can only make a verdict stricter, and any failure (timeout, error, unreadable reply) holds the payment for a human.

**Settler**: the adapter that actually moves money on a rail (mock today, Payfrom later). Idempotent on payment id. _Code_: `Settler`, `src/settle/`.

**Settlement**: the settler sending an approved payment: *settling* becomes *settled* with a reference, or *failed* with the reason.

**Core**: the one interface the outside world (MCP, REST, dashboard, demo, bench) uses to reach the firewall. _Code_: `Core` in `src/types.ts`, built by `createCore`.
