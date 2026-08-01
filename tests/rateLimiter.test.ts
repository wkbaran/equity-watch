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
