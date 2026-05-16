// Typed errors. The provider router uses these to decide whether to fall back
// from marudor to db-rest. Anything not a ProviderError is unexpected and
// should bubble out as a tool-call failure.

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly source: "marudor" | "db-rest",
    public readonly kind: "timeout" | "http" | "parse" | "not_found",
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProviderError";
  }
}

export class AllProvidersFailedError extends Error {
  constructor(public readonly errors: ProviderError[]) {
    super(`All providers failed: ${errors.map((e) => e.message).join("; ")}`, {
      cause: errors[0],
    });
    this.name = "AllProvidersFailedError";
  }
}
