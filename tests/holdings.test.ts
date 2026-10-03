import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ABOVE_BASIS_THRESHOLD_PCT, checkHoldings, STAGNANT_MAX_PROFIT_PCT, STAGNANT_MIN_DAYS, STOP_ATR_MULTIPLE } from "../src/holdings/engine.js";
import { computeBasis, emptyHoldingsStore, type HoldingsStore, type Lot } from "../src/holdings/models.js";
import type { Quote } from "../src/providers/schwab.js";

function fakeMarket(prices: Record<string, number>) {
  return {
    getQuotes: async (symbols: string[]) => {
      const result = new Map<string, Quote>();
      for (const s of symbols) {
        if (prices[s] !== undefined) {
          result.set(s, { lastPrice: prices[s], totalVolume: 0 });
        }
      }
      return result;
    },
  };
}

function makeLot(overrides: Partial<Lot> = {}): Lot {
  return {
    id: "l1",
    symbol: "TEST",
    count: 100,
    basisPerShare: 100,
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function storeWithLots(lots: Lot[]): HoldingsStore {
  return { ...emptyHoldingsStore(), lots };
}

describe("computeBasis", () => {
  it("returns null for a symbol with no lots", () => {
    expect(computeBasis([], "TEST")).toBeNull();
  });

  it("blends multiple lots by weighted average", () => {
    const lots = [
      makeLot({ id: "l1", count: 100, basisPerShare: 100, purchaseDate: "2026-01-01" }),
      makeLot({ id: "l2", count: 100, basisPerShare: 120, purchaseDate: "2026-02-01" }),
    ];
    const info = computeBasis(lots, "TEST")!;
    expect(info.totalCount).toBe(200);
    expect(info.blendedBasis).toBe(110);
    expect(info.lastPurchaseDate).toBe("2026-02-01");
  });

  it("ignores lots for other symbols", () => {
    const lots = [makeLot({ symbol: "OTHER" }), makeLot({ symbol: "TEST", basisPerShare: 50 })];
    const info = computeBasis(lots, "TEST")!;
    expect(info.blendedBasis).toBe(50);
  });
});

describe("checkHoldings", () => {
  it("seeds baseline state on the first check without firing anything", async () => {
    // Price is already 20% above basis - would fire if not for first-check seeding.
    const store = storeWithLots([makeLot({ basisPerShare: 100 })]);
    const { triggered } = await checkHoldings(store, fakeMarket({ TEST: 120 }), []);
    expect(triggered).toHaveLength(0);
    expect(store.alertState[0].initialized).toBe(true);
  });

  it("fires above_basis once when price crosses 10% above basis, and doesn't re-fire while it stays there", async () => {
    const store = storeWithLots([makeLot({ basisPerShare: 100 })]);
    await checkHoldings(store, fakeMarket({ TEST: 100 }), []); // seed at basis

    const first = await checkHoldings(store, fakeMarket({ TEST: 111 }), []);
    expect(first.triggered.map((t) => t.type)).toEqual(["above_basis", "raise_stop"]);

    const second = await checkHoldings(store, fakeMarket({ TEST: 112 }), []);
    expect(second.triggered.find((t) => t.type === "above_basis")).toBeUndefined();
  });

  it("re-fires above_basis after a pullback below threshold and a fresh recross", async () => {
    const store = storeWithLots([makeLot({ basisPerShare: 100 })]);
    await checkHoldings(store, fakeMarket({ TEST: 100 }), []); // seed
    await checkHoldings(store, fakeMarket({ TEST: 111 }), []); // fires
    await checkHoldings(store, fakeMarket({ TEST: 105 }), []); // pulls back below 10%

    const { triggered } = await checkHoldings(store, fakeMarket({ TEST: 112 }), []); // recrosses
    expect(triggered.some((t) => t.type === "above_basis")).toBe(true);
  });

  it("fires stagnant only once both the day and profit conditions hold, and quiets down after a fresh lot", async () => {
    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const store = storeWithLots([makeLot({ basisPerShare: 100, purchaseDate: oldDate })]);
    await checkHoldings(store, fakeMarket({ TEST: 101 }), []); // seed (already stagnant-eligible, so seeded true)

    // Confirm seeding suppressed the first-ever firing.
    expect(store.alertState[0].stagnantArmed).toBe(true);

    // A fresh purchase resets lastPurchaseDate, so the days-since condition
    // goes false on the very next check via natural recomputation.
    store.lots.push(makeLot({ id: "l2", count: 10, basisPerShare: 101, purchaseDate: new Date().toISOString().slice(0, 10) }));
    const { triggered } = await checkHoldings(store, fakeMarket({ TEST: 101 }), []);
    expect(triggered.find((t) => t.type === "stagnant")).toBeUndefined();
    expect(store.alertState[0].stagnantArmed).toBe(false);
  });

  it("ratchets the 3% appreciation band up only, never re-firing a previously-reached band", async () => {
    const store = storeWithLots([makeLot({ basisPerShare: 100 })]);
    await checkHoldings(store, fakeMarket({ TEST: 100 }), []); // seed at band 0

    const at4 = await checkHoldings(store, fakeMarket({ TEST: 104 }), []); // band 1
    expect(at4.triggered.filter((t) => t.type === "raise_stop")).toHaveLength(1);

    const pullback = await checkHoldings(store, fakeMarket({ TEST: 101 }), []); // still band 0, no new band
    expect(pullback.triggered.filter((t) => t.type === "raise_stop")).toHaveLength(0);

    const backTo4 = await checkHoldings(store, fakeMarket({ TEST: 104 }), []); // re-enters band 1, already notified
    expect(backTo4.triggered.filter((t) => t.type === "raise_stop")).toHaveLength(0);

    const at7 = await checkHoldings(store, fakeMarket({ TEST: 107 }), []); // band 2, new territory
    expect(at7.triggered.filter((t) => t.type === "raise_stop")).toHaveLength(1);
  });

  it("skips a symbol with no quote available", async () => {
    const store = storeWithLots([makeLot({ symbol: "MISSING" })]);
    const { checked, triggered } = await checkHoldings(store, fakeMarket({}), []);
    expect(checked).toBe(1);
    expect(triggered).toHaveLength(0);
  });
});

/**
 * `holdings check` reports its verdicts to a CSV and isn't in the scheduled
 * run, so the page never saw them. It shows two of the three as state on a
 * holdings row instead — computed in the browser, because `pctAboveBasis`
 * plus a price gives the basis away and nothing basis-derived may be published.
 *
 * That means a second copy of the thresholds, so diff them. Same trick as the
 * volume mirror and the vault key prefix.
 */
interface FlagRow {
  pctFromBasis: number | null;
  lastPurchaseDate: string;
  price: number | null;
  atr?: number | null;
  stops: number[];
  ignored: boolean;
}

describe("web/app.js mirrors the holdings thresholds", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf-8");
  const start = appJs.indexOf("  const ABOVE_BASIS_THRESHOLD_PCT =");
  const end = appJs.indexOf("  // ---- end of the src/holdings/engine.ts mirror");

  it("keeps the block where the test expects it", () => {
    expect(start, "the holdings-threshold block moved in web/app.js").toBeGreaterThan(-1);
    expect(end, "the end-of-mirror marker moved in web/app.js").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  const copy = new Function(
    `${appJs.slice(start, end)}\nreturn { holdingFlags, ABOVE_BASIS_THRESHOLD_PCT, STAGNANT_MIN_DAYS, STAGNANT_MAX_PROFIT_PCT, STOP_ATR_MULTIPLE };`
  )() as {
    holdingFlags: (row: FlagRow, now?: number) => { kind: string; title: string }[];
    ABOVE_BASIS_THRESHOLD_PCT: number;
    STAGNANT_MIN_DAYS: number;
    STAGNANT_MAX_PROFIT_PCT: number;
    STOP_ATR_MULTIPLE: number;
  };

  it("uses the engine's numbers, not its own", () => {
    expect(copy.ABOVE_BASIS_THRESHOLD_PCT).toBe(ABOVE_BASIS_THRESHOLD_PCT);
    expect(copy.STAGNANT_MIN_DAYS).toBe(STAGNANT_MIN_DAYS);
    expect(copy.STAGNANT_MAX_PROFIT_PCT).toBe(STAGNANT_MAX_PROFIT_PCT);
    expect(copy.STOP_ATR_MULTIPLE).toBe(STOP_ATR_MULTIPLE);
  });

  const NOW = new Date("2026-09-21T12:00:00.000Z").getTime();
  // A stop far enough away that it never adds a flag of its own.
  const kinds = (pctFromBasis: number | null, lastPurchaseDate: string) =>
    copy.holdingFlags({ pctFromBasis, lastPurchaseDate, price: 100, atr: 1, stops: [50], ignored: false }, NOW).map((f) => f.kind);

  it("flags a position at or past the threshold, and not one just under it", () => {
    expect(kinds(10, "2026-09-20")).toEqual(["above-basis"]);
    expect(kinds(9.9, "2026-09-20")).toEqual([]);
  });

  it("flags a stagnant position only once it is both old enough and flat enough", () => {
    expect(kinds(1, "2026-08-01")).toEqual(["stagnant"]); // 51 days, +1%
    expect(kinds(1, "2026-09-20")).toEqual([]); // flat but new
    expect(kinds(5, "2026-08-01")).toEqual([]); // old but up 5%
  });

  it("says nothing about a position with no quote", () => {
    expect(kinds(null, "2026-08-01")).toEqual([]);
  });

  // A loss is stagnant too: the condition is "hasn't gone anywhere", and money
  // sitting in a loser for two months is exactly what it is meant to surface.
  it("counts a long-held loss as stagnant", () => {
    expect(kinds(-12, "2026-06-01")).toEqual(["stagnant"]);
  });

  describe("stop flags", () => {
    const stopKinds = (row: Partial<FlagRow>) =>
      copy
        .holdingFlags({ pctFromBasis: 0, lastPurchaseDate: "2026-09-20", price: 100, atr: 3, stops: [], ignored: false, ...row }, NOW)
        .map((f) => f.kind);

    it("flags a position with no stop, unless it is ignored", () => {
      expect(stopKinds({})).toEqual(["no-stop"]);
      expect(stopKinds({ ignored: true })).toEqual([]);
    });

    it("flags a stop inside two ATRs, measured from the nearest stop", () => {
      // ATR 3: two ATRs is 6 under 100.
      expect(stopKinds({ stops: [95] })).toEqual(["stop-tight"]);
      expect(stopKinds({ stops: [94] })).toEqual([]);
      expect(stopKinds({ stops: [80, 95] })).toEqual(["stop-tight"]);
    });

    it("never rounds a stop just inside the multiple up to it", () => {
      // 5.97 / 3 = 1.99 ATR: tight, and it must not say "2.0".
      const [flag] = copy.holdingFlags({ pctFromBasis: 0, lastPurchaseDate: "2026-09-20", price: 100, atr: 3, stops: [94.03], ignored: false }, NOW);
      expect(flag.kind).toBe("stop-tight");
      expect(flag.title).toMatch(/is 1\.9 ATR under/);
    });

    it("says the price is under a stop above it", () => {
      const [flag] = copy.holdingFlags({ pctFromBasis: 0, lastPurchaseDate: "2026-09-20", price: 100, atr: 3, stops: [105], ignored: false }, NOW);
      expect(flag.kind).toBe("stop-tight");
      expect(flag.title).toMatch(/under the stop/);
    });

    it("can't judge tightness without an ATR or a quote", () => {
      expect(stopKinds({ atr: null, stops: [99] })).toEqual([]);
      expect(stopKinds({ atr: undefined, stops: [99] })).toEqual([]);
      expect(stopKinds({ atr: 0, stops: [99] })).toEqual([]);
      expect(stopKinds({ price: null, pctFromBasis: null, stops: [99] })).toEqual([]);
      expect(stopKinds({ price: null, pctFromBasis: null })).toEqual(["no-stop"]);
    });
  });
});
