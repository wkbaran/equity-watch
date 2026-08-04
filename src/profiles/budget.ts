/**
 * A cross-invocation daily request budget (FMP's free tier is 250/day, and
 * a single CLI run can't track that alone since the process exits between
 * `profile fetch` calls). Persisted as one small JSON file; resets when the
 * calendar date rolls over.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface BudgetState {
  date: string;
  count: number;
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class DailyBudget {
  constructor(
    private path: string,
    private limit: number
  ) {}

  private load(now: Date): BudgetState {
    if (existsSync(this.path)) {
      const state = JSON.parse(readFileSync(this.path, "utf-8")) as BudgetState;
      if (state.date === todayKey(now)) {
        return state;
      }
    }
    return { date: todayKey(now), count: 0 };
  }

  private save(state: BudgetState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2));
  }

  remaining(now: Date = new Date()): number {
    return Math.max(0, this.limit - this.load(now).count);
  }

  /** Attempts to consume one unit of today's budget. Returns false if none remains. */
  consume(now: Date = new Date()): boolean {
    const state = this.load(now);
    if (state.count >= this.limit) {
      return false;
    }
    state.count += 1;
    this.save(state);
    return true;
  }
}
