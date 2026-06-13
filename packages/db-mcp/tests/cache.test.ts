import { describe, expect, it, vi } from "vitest";
import { createCache } from "../src/cache.js";

describe("createCache", () => {
  it("returns cached value within TTL", async () => {
    const cache = createCache<string>({ ttlMs: 1000, max: 10 });
    const fn = vi.fn().mockResolvedValue("first");
    const a = await cache.getOrCompute("k", fn);
    const b = await cache.getOrCompute("k", fn);
    expect(a).toBe("first");
    expect(b).toBe("first");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("recomputes after TTL expiry", async () => {
    vi.useFakeTimers();
    const cache = createCache<string>({ ttlMs: 1000, max: 10 });
    const fn = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    expect(await cache.getOrCompute("k", fn)).toBe("first");
    vi.advanceTimersByTime(1500);
    expect(await cache.getOrCompute("k", fn)).toBe("second");
    vi.useRealTimers();
  });
});
