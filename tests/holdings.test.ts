import { describe, expect, it } from "vitest";
import { checkHoldings } from "../src/holdings/engine.js";
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
