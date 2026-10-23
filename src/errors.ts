// `kind` lets callers answer 404 / 409 without re-reading state.
export class CoreError extends Error {
  constructor(readonly kind: "not_found" | "wrong_state", message: string) {
    super(message);
    this.name = "CoreError";
  }
}
