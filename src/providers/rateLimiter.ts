/**
 * Sliding-window rate limiter. Tracks recent call timestamps and, once
 * `maxCalls` have happened within `windowMs`, makes the next `acquire()`
 * wait until the oldest of them ages out of the window.
 */
export class RateLimiter {
  private callTimes: number[] = [];

  constructor(
    private maxCalls: number,
    private windowMs: number
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.callTimes = this.callTimes.filter((t) => now - t < this.windowMs);
      if (this.callTimes.length < this.maxCalls) {
        this.callTimes.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.callTimes[0]);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
