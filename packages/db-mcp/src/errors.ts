// Typed errors for upstream data sources. Tools turn these into readable
// tool-call failures; anything that is not a ProviderError is a bug.

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly source: "transitous" | "dwd",
    public readonly kind: "timeout" | "http" | "parse" | "not_found",
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProviderError";
  }
}
