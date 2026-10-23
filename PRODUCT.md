# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
A business owner or finance lead who has delegated spending to an AI agent (Claude Code, Claude Desktop or any MCP client). They open the dashboard on a laptop, in daylight, a few times a day: to set the agent's budget and rules, to approve or deny payments the firewall held back, and to see what was stopped. (Confirmed with the user.)

## Product Purpose
Spend Firewall sits between an AI agent and its money. The owner writes a mandate (one currency, a budget, limits, an allowlist of recipients); the agent can only ask to pay, and each request is approved, held for a human, or blocked. The agent can never change its own rules. Success is an owner who trusts the agent with real spending because nothing outside the mandate gets through.

## Positioning
The agent-facing endpoint has no tool that can read or edit the rules, and an LLM check can only make a verdict stricter, never looser.

## Capabilities and Constraints
- Dashboard is a single file: public/index.html, vanilla JS, no build step, no frameworks, no external scripts.
- Polls the REST API every 2 seconds with an admin token held in sessionStorage (gone when the tab closes).
- Mandates are currency- and rail-agnostic; the UI never hardcodes a currency or an address format.
- Settlement is currently a mock rail; real rails come later.

## Brand Commitments
Name: Spend Firewall.

## Evidence on Hand
No customers, testimonials or benchmarks beyond the attack bench in bench/. None may be invented.

## Product Principles
- The held-for-human payment is the main job: it must be impossible to miss and quick to decide.
- Show why, in plain English, every time something is held or blocked.
- Trust comes from precision and calm, not from alarm or decoration.

## Accessibility & Inclusion
Legible on a projector and a phone; keyboard operable; respects reduced motion. Colour is never the only carrier of meaning.
