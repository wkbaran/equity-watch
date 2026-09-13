import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/providers/rateLimiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets calls through immediately while under the limit", async () => {
    const limiter = new RateLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      await limiter.acquire();
    }
    // No pending timers means none of the calls above had to wait.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delays the (N+1)th call until the window rolls over", async () => {
    const limiter = new RateLimiter(2, 1000);
    await limiter.acquire();
    await limiter.acquire();

    let resolved = false;
    const pending = limiter.acquire().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it("does not wait for calls spaced beyond the window", async () => {
    const limiter = new RateLimiter(1, 1000);
    await limiter.acquire();

    await vi.advanceTimersByTimeAsync(1000);

    let resolved = false;
    const pending = limiter.acquire().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
    await pending;
  });
});

describe("quote batching", () => {
  it("caps a batch at Schwab's documented 500-symbol limit", async () => {
    // Schwab rejects a larger ask outright: "Search combination should not
    // exceed 500". A 516-symbol watchlist is a realistic size here.
    const { MAX_QUOTE_SYMBOLS_PER_REQUEST, SchwabProvider } = await import("../src/providers/schwab.js");
    expect(MAX_QUOTE_SYMBOLS_PER_REQUEST).toBe(500);

    const batches: number[] = [];
    const provider = Object.create(SchwabProvider.prototype) as InstanceType<typeof SchwabProvider>;
    // Stand in for the network call, recording how the symbols were split.
    const original = SchwabProvider.prototype.getQuotes;
    let depth = 0;
    (provider as unknown as { rateLimiter: unknown }).rateLimiter = { acquire: async () => {} };
    const spy = async function (this: unknown, symbols: string[]): Promise<Map<string, unknown>> {
      if (symbols.length > MAX_QUOTE_SYMBOLS_PER_REQUEST) {
        depth++;
        return original.call(this as never, symbols) as never;
      }
      batches.push(symbols.length);
      return new Map(symbols.map((s) => [s, { lastPrice: 1, totalVolume: 0 }]));
    };
    (provider as unknown as { getQuotes: unknown }).getQuotes = spy;

    const symbols = Array.from({ length: 516 }, (_, i) => `S${i}`);
    const result = await original.call(provider as never, symbols);

    expect(batches).toEqual([500, 16]);
    expect(result.size).toBe(516);
    expect(depth).toBe(0);
  });

  it("makes a single request when under the limit", async () => {
    const { MAX_QUOTE_SYMBOLS_PER_REQUEST } = await import("../src/providers/schwab.js");
    expect(500 % MAX_QUOTE_SYMBOLS_PER_REQUEST).toBe(0);
  });
});
