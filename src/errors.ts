// The errors Core throws on purpose. `kind` lets the REST and MCP modules answer
// (404, 409) without re-reading state; the message is plain English for humans.
export class CoreError extends Error {
  constructor(readonly kind: "not_found" | "wrong_state", message: string) {
    super(message);
    this.name = "CoreError";
  }
}
