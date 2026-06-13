import { LRUCache } from "lru-cache";

export interface CacheOptions {
  max: number;
  ttlMs: number;
}

export interface Cache<T> {
  getOrCompute: (key: string, compute: () => Promise<T>) => Promise<T>;
}

export function createCache<T extends {}>(opts: CacheOptions): Cache<T> {
  const store = new LRUCache<string, { value: T; expiresAt: number }>({
    max: opts.max,
  });

  return {
    async getOrCompute(key, compute) {
      const now = Date.now();
      const cached = store.get(key);

      if (cached !== undefined && cached.expiresAt > now) {
        return cached.value;
      }

      const value = await compute();
      store.set(key, { value, expiresAt: now + opts.ttlMs });
      return value;
    },
  };
}
