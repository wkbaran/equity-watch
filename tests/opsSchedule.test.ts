import { describe, expect, it } from "vitest";
import { drainIntervalMinutes, MAX_DRAIN_HISTORY, recordDrain, type OpsPullState } from "../src/ops/schedule.js";

/** `count` drains `everyMin` apart, ending at `end`. */
function drains(count: number, everyMin: number, end = new Date("2026-09-16T18:10:00.000Z")): string[] {
  return Array.from({ length: count }, (_, i) => new Date(end.getTime() - (count - 1 - i) * everyMin * 60_000).toISOString());
}

describe("recordDrain", () => {
  it("starts a history from a store that has none", () => {
    const state = recordDrain(null, "2026-09-16T18:10:00.000Z");
    expect(state).toEqual({ processedThrough: "2026-09-16T18:10:00.000Z", recentDrains: ["2026-09-16T18:10:00.000Z"] });
  });

  it("upgrades a store written before the history existed", () => {
    const legacy = { processedThrough: "2026-09-16T17:55:00.000Z" } as OpsPullState;
    expect(recordDrain(legacy, "2026-09-16T18:10:00.000Z").recentDrains).toEqual(["2026-09-16T18:10:00.000Z"]);
  });

  it("keeps the watermark and the history in step, capped", () => {
    let state: OpsPullState | null = null;
    for (const at of drains(MAX_DRAIN_HISTORY + 5, 15)) {
      state = recordDrain(state, at);
    }
    expect(state!.recentDrains).toHaveLength(MAX_DRAIN_HISTORY);
    expect(state!.processedThrough).toBe(state!.recentDrains!.at(-1));
  });
});

describe("drainIntervalMinutes", () => {
  it("says nothing until enough drains are recorded", () => {
    expect(drainIntervalMinutes(null)).toBeNull();
    expect(drainIntervalMinutes({ processedThrough: drains(1, 15)[0], recentDrains: drains(1, 15) })).toBeNull();
    expect(drainIntervalMinutes({ processedThrough: "x", recentDrains: drains(3, 15) })).toBeNull();
    expect(drainIntervalMinutes({ processedThrough: "x", recentDrains: drains(4, 15) })).toBe(15);
  });

  // The whole reason this is a median. The real schedule stops for the night,
  // so one gap in twelve is nearly eight hours; a mean would read that as the
  // cadence and promise "applies in ~1 hr" all the next day.
  it("ignores the overnight gap", () => {
    const evening = drains(6, 15, new Date("2026-09-16T18:10:00.000Z"));
    const morning = drains(6, 15, new Date("2026-09-17T03:10:00.000Z"));
    const state = { processedThrough: morning.at(-1)!, recentDrains: [...evening, ...morning] };
    expect(drainIntervalMinutes(state)).toBe(15);
  });

  it("follows a cadence that actually changes", () => {
    expect(drainIntervalMinutes({ processedThrough: "x", recentDrains: drains(8, 5) })).toBe(5);
  });

  it("skips gaps a clock change or a hand-edited store could leave behind", () => {
    const history = drains(5, 15);
    // A repeat of the previous timestamp: a zero gap, which must not drag the median to 0.
    const state = { processedThrough: "x", recentDrains: [...history, history.at(-1)!] };
    expect(drainIntervalMinutes(state)).toBe(15);
  });
});
