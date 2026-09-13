import { describe, expect, it } from "vitest";
import { buildDashboard, renderDashboard } from "../src/dashboard.js";
import type { Alert, StaticAlert, VolumeAlert } from "../src/alerts/models.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";
import { scoreRevisit } from "../src/alerts/revisit.js";
import { emptyHoldingsStore, type HoldingsStore } from "../src/holdings/models.js";
import type { Quote } from "../src/providers/schwab.js";
import { dashboardFingerprint, siteDocument } from "../src/web/site.js";
import { buildAlertRows } from "../src/web/alertsPage.js";

describe("chart links", () => {
  const exchanges = new Map([
    ["PPL", "NYSE"],
    ["BIL", "AMEX"],
  ]);

  it("prefix the exchange on every row and publish prefixes for symbols without a row", () => {
    const d = base({
      alerts: [staticAlert({ symbol: "PPL" })],
      revisits: [revisit({ symbol: "PPL" })],
      holdings: holdingsWith("BIL", 10, 90),
      exchanges,
    });
    const ppl = "https://www.tradingview.com/chart/?symbol=NYSE%3APPL";
    expect(d.revisitQueue[0].chartUrl).toBe(ppl);
    expect(d.recentTriggers[0].chartUrl).toBe(ppl);
    expect(d.tradingViewPrefixes).toEqual({ PPL: "NYSE", BIL: "AMEX" });
    expect(buildAlertRows([staticAlert({ symbol: "PPL" })], new Map(), new Set(), exchanges)[0].chartUrl).toBe(ppl);
  });

  it("fall back to the bare symbol with no cached exchange", () => {
    const d = base({ revisits: [revisit()] });
    expect(d.revisitQueue[0].chartUrl).toBe("https://www.tradingview.com/chart/?symbol=AAPL");
    expect(d.tradingViewPrefixes).toEqual({});
  });
});

const NOW = new Date("2026-09-12T12:00:00.000Z");

function staticAlert(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    id: "a1",
    symbol: "AAPL",
    status: "live",
    createdAt: "2026-09-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-01-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "static",
    side: "above",
    level: 110,
    lastKnownSide: "below",
    ...overrides,
  };
}

function revisit(overrides: Partial<RevisitEntry> = {}): RevisitEntry {
  return {
    id: "r1",
    alertId: "a1",
    symbol: "AAPL",
    kind: "static",
    triggeredAt: "2026-09-10T12:00:00.000Z",
    triggerPrice: 112,
    levelAtTrigger: 110,
    session: null,
    watchingSince: null,
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    appliedFrom: null,
    appliedTo: null,
    status: "open",
    suggestedLevel: null,
    suggestedAt: null,
    suggestionBasis: null,
    resolvedAt: null,
    priority: null,
    signals: null,
    ...overrides,
  };
}

function quotes(map: Record<string, number>): Map<string, Quote> {
  return new Map(Object.entries(map).map(([s, lastPrice]) => [s, { lastPrice, totalVolume: 0 }]));
}

function holdingsWith(symbol: string, count: number, basis: number): HoldingsStore {
  const store = emptyHoldingsStore();
  store.lots.push({
    id: "l1",
    symbol,
    count,
    basisPerShare: basis,
    purchaseDate: "2026-08-01",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return store;
}

function base(overrides: Partial<Parameters<typeof buildDashboard>[0]> = {}) {
  return buildDashboard({
    alerts: [],
    revisits: [],
    holdings: emptyHoldingsStore(),
    quotes: new Map(),
    now: NOW,
    ...overrides,
  });
}

describe("recentTriggers", () => {
  it("lists every trigger in the window whatever its status, plus older open ones, newest first", () => {
    const d = base({
      revisits: [
        revisit({ id: "oldOpen", triggeredAt: "2026-09-01T12:00:00.000Z" }),
        revisit({ id: "oldDismissed", triggeredAt: "2026-09-01T13:00:00.000Z", status: "dismissed" }),
        revisit({ id: "mid", triggeredAt: "2026-09-10T12:00:00.000Z", status: "dismissed" }),
        revisit({ id: "new", triggeredAt: "2026-09-11T12:00:00.000Z", status: "applied" }),
      ],
    });
    // The queue only holds open entries; this list is what a poller diffs for
    // news, and every queue row must be able to open its details from it.
    expect(d.recentTriggers.map((t) => t.id)).toEqual(["new", "mid", "oldOpen"]);
    expect(d.recentTriggers[0].headline).toContain("AAPL");
  });

  it("carries trigger details, preferring what was recorded at trigger time", () => {
    const recorded = revisit({
      id: "rec",
      condition: "volume >= 1000 today",
      volume: { observed: 1500, required: 1000, window: "today", basis: "threshold" },
    });
    const fallback = revisit({ id: "cur", triggeredAt: "2026-09-11T12:00:00.000Z" });
    const orphan = revisit({ id: "gone", alertId: "removed", triggeredAt: "2026-09-11T13:00:00.000Z" });
    const d = base({ alerts: [staticAlert()], revisits: [recorded, fallback, orphan] });
    const byId = Object.fromEntries(d.recentTriggers.map((t) => [t.id, t]));

    expect(byId.rec).toMatchObject({ condition: "volume >= 1000 today", conditionSource: "recorded", alertExists: true, volume: { observed: 1500 } });
    // Older entries fall back to the alert as it is now, and say so.
    expect(byId.cur).toMatchObject({ condition: "price crosses 110", conditionSource: "current", volume: null });
    // Nothing recorded and nothing to fall back on: null, not a guess.
    expect(byId.gone).toMatchObject({ condition: null, conditionSource: null, alertExists: false, alertId: "removed" });
  });

  it("drops ignored symbols", () => {
    const d = base({ revisits: [revisit({ symbol: "BIL" })], ignoredSymbols: new Set(["BIL"]) });
    expect(d.recentTriggers).toEqual([]);
  });
});

describe("siteDocument", () => {
  const held = () => base({ revisits: [revisit()], holdings: holdingsWith("AAPL", 10, 100), quotes: quotes({ AAPL: 150 }) });

  it("removes share counts, basis, and value when holdings are off, but keeps that a name is held", () => {
    const doc = siteDocument(held(), { holdings: false });
    expect(doc.holdings).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/"shares"|"basis"|"marketValue"/);
    // Being held is not sensitive on its own; only size and value are.
    expect(doc.revisitQueue[0].headline).toMatch(/^Holding AAPL/);
    expect(doc.recentTriggers[0].heldPosition).toBe(true);
  });

  it("keeps holdings rows when enabled", () => {
    expect(siteDocument(held(), { holdings: true }).holdings[0].shares).toBe(10);
  });

  it("doesn't let holdings changes move the fingerprint while holdings are off", () => {
    const more = base({ revisits: [revisit()], holdings: holdingsWith("AAPL", 20, 90) });
    const off = { holdings: false };
    expect(dashboardFingerprint(siteDocument(held(), off))).toBe(dashboardFingerprint(siteDocument(more, off)));
  });
});

describe("dashboardFingerprint", () => {
  const inputs = () => ({
    alerts: [staticAlert()],
    revisits: [revisit({ watchingSince: "2026-01-01T00:00:00.000Z", priceAtWatchStart: 80 })],
    holdings: holdingsWith("AAPL", 10, 100),
  });

  it("is the same with and without quotes, at different times", () => {
    // The CLI relies on this to decide whether to publish before fetching quotes.
    const withQuotes = base({ ...inputs(), quotes: quotes({ AAPL: 150 }) });
    const without = base({ ...inputs(), now: new Date(NOW.getTime() + 60_000) });
    expect(withQuotes.holdings[0].price).toBe(150);
    expect(withQuotes.revisitQueue[0].sinceWatching).not.toBeNull();
    expect(dashboardFingerprint(withQuotes)).toBe(dashboardFingerprint(without));
  });

  it("changes when something happens", () => {
    const before = dashboardFingerprint(base(inputs()));
    const fired = inputs();
    fired.revisits.push(revisit({ id: "r2", triggeredAt: "2026-09-11T12:00:00.000Z" }));
    expect(dashboardFingerprint(base(fired))).not.toBe(before);

    const dismissed = inputs();
    dismissed.revisits[0].status = "dismissed";
    expect(dashboardFingerprint(base(dismissed))).not.toBe(before);
  });
});

describe("buildDashboard", () => {
  it("renders a meaningful document on a completely quiet day", () => {
    // The whole point of a periodic report: nothing fired, but the standing
    // state still has to be legible.
    const d = base({ alerts: [staticAlert()], quotes: quotes({ AAPL: 50 }) });
    expect(d.summary.liveAlerts).toBe(1);
    expect(d.summary.openRevisits).toBe(0);
    expect(d.revisitQueue).toEqual([]);
    expect(renderDashboard(d)).toContain("nothing waiting on a decision");
  });

  it("ranks the revisit queue by priority, unscored entries last", () => {
    const hot = revisit({ id: "hot", symbol: "NVDA", priority: 80 });
    const mild = revisit({ id: "mild", symbol: "CF", priority: 30 });
    const unscored = revisit({ id: "cold", symbol: "GO", priority: null });
    const d = base({ revisits: [mild, unscored, hot] });
    expect(d.revisitQueue.map((r) => r.id)).toEqual(["hot", "mild", "cold"]);
  });

  it("counts only open entries as the queue, but counts all recent ones as triggers", () => {
    const d = base({
      revisits: [
        revisit({ id: "o", status: "open" }),
        revisit({ id: "a", status: "applied" }),
        revisit({ id: "d", status: "dismissed" }),
      ],
    });
    expect(d.summary.openRevisits).toBe(1);
    expect(d.summary.triggersInWindow).toBe(3); // all three fired within the window
  });

  it("separates entries that are actionable from ones still awaiting a relevel pass", () => {
    const d = base({
      revisits: [revisit({ id: "1", suggestedLevel: 120 }), revisit({ id: "2", suggestedLevel: null })],
    });
    expect(d.summary.openRevisits).toBe(2);
    expect(d.summary.actionableRevisits).toBe(1);
  });

  it("excludes triggers older than the window", () => {
    const d = base({
      revisits: [revisit({ triggeredAt: "2026-01-01T00:00:00.000Z" })],
      windowDays: 7,
    });
    expect(d.summary.triggersInWindow).toBe(0);
    expect(d.summary.openRevisits).toBe(1); // still open, just not recent
  });

  it("reports distance to trigger as how far price must still move", () => {
    const d = base({ alerts: [staticAlert({ level: 110 })], quotes: quotes({ AAPL: 100 }), approachingWithinPct: 20, includeApproaching: true });
    expect(d.approaching[0].distancePct).toBe(10);
  });

  it("uses the same sign convention for a downside alert", () => {
    // A below alert at 90 with price at 100 is also 10% away, not -10%.
    const d = base({
      alerts: [staticAlert({ side: "below", level: 90, lastKnownSide: "above" })],
      quotes: quotes({ AAPL: 100 }),
      approachingWithinPct: 20,
      includeApproaching: true,
    });
    expect(d.approaching[0].distancePct).toBe(10);
  });

  it("reports an already-met condition as negative distance rather than hiding it", () => {
    // A below alert at 90 with price already at 85: the price condition is
    // met and it is only still live because a volume gate hasn't caught up.
    const d = base({
      alerts: [staticAlert({ side: "below", level: 90, lastKnownSide: "below" })],
      quotes: quotes({ AAPL: 85 }),
      includeApproaching: true,
    });
    expect(d.approaching[0].distancePct).toBeLessThan(0);
  });

  it("drops alerts further away than the cutoff but keeps close ones", () => {
    const near = staticAlert({ id: "near", symbol: "NEAR", level: 102 });
    const far = staticAlert({ id: "far", symbol: "FAR", level: 300 });
    const d = base({
      alerts: [near, far],
      quotes: quotes({ NEAR: 100, FAR: 100 }),
      approachingWithinPct: 5,
      includeApproaching: true,
    });
    expect(d.approaching.map((a) => a.symbol)).toEqual(["NEAR"]);
  });

  it("keeps volume-only alerts visible with no price distance", () => {
    const vol: VolumeAlert = {
      ...staticAlert({ id: "v1", symbol: "PNC" }),
      kind: "volume",
      volume: { threshold: 2_600_000, mode: "today" },
    } as unknown as VolumeAlert;
    const d = base({ alerts: [vol as Alert], quotes: quotes({ PNC: 180 }), includeApproaching: true });
    expect(d.approaching).toHaveLength(1);
    expect(d.approaching[0].distancePct).toBeNull();
    expect(d.approaching[0].hasVolumeCondition).toBe(true);
  });

  it("ignores cancelled alerts entirely", () => {
    const d = base({
      alerts: [staticAlert({ status: "cancelled" })],
      quotes: quotes({ AAPL: 109 }),
    });
    expect(d.summary.liveAlerts).toBe(0);
    expect(d.approaching).toEqual([]);
  });

  it("counts missing quotes instead of silently under-reporting coverage", () => {
    const d = base({ alerts: [staticAlert()], quotes: new Map() });
    expect(d.summary.quotesUnavailable).toBe(1);
    expect(d.approaching).toEqual([]);
  });

  it("marks queue entries on symbols actually held", () => {
    const d = base({ revisits: [revisit({ symbol: "AAPL" })], holdings: holdingsWith("AAPL", 100, 150) });
    expect(d.revisitQueue[0].heldPosition).toBe(true);
  });

  it("reports positions against blended basis", () => {
    const d = base({ holdings: holdingsWith("AAPL", 100, 150), quotes: quotes({ AAPL: 165 }) });
    expect(d.holdings[0]).toMatchObject({ symbol: "AAPL", shares: 100, basis: 150, pctFromBasis: 10, marketValue: 16500 });
  });

  it("still lists a position when its quote is missing", () => {
    const d = base({ holdings: holdingsWith("AAPL", 100, 150), quotes: new Map() });
    expect(d.holdings[0].price).toBeNull();
    expect(d.holdings[0].pctFromBasis).toBeNull();
  });

  it("carries the priority explanation through to the rendered view", () => {
    const { priority, signals } = scoreRevisit({
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 6,
      daysOpen: 2,
      heldPosition: true,
      volumeRatio: 2.2,
      volumeTrendRatio: 1.4,
    });
    const d = base({ revisits: [revisit({ priority, signals, suggestedLevel: 125 })] });
    const text = renderDashboard(d);
    expect(text).toContain("CONFIRMED_BREAKOUT");
    expect(text).toContain("Suggest moving 110 to 125.");
    expect(text).toContain("alert revisit apply r1");
  });

  it("leads each queue row with a plain-English headline", () => {
    const { priority, signals } = scoreRevisit({
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 6,
      daysOpen: 1,
      heldPosition: false,
      volumeRatio: 2.4,
      volumeTrendRatio: 1.5,
    });
    const d = base({ revisits: [revisit({ symbol: "TGT", priority, signals })] });
    expect(d.revisitQueue[0].headline).toBe("TGT broke resistance with volume, now 6.0% above it");
  });

  it("names a position in the headline so it reads differently from a watchlist name", () => {
    const { priority, signals } = scoreRevisit({
      verdict: "WATCH",
      pctMovePastLevel: -3,
      daysOpen: 1,
      heldPosition: true,
      volumeRatio: 1.9,
      volumeTrendRatio: 1.3,
    });
    const d = base({
      revisits: [revisit({ symbol: "MKS", priority, signals, levelAtTrigger: 110, triggerPrice: 104 })],
      holdings: holdingsWith("MKS", 50, 100),
    });
    expect(d.revisitQueue[0].headline).toContain("Holding MKS");
    expect(d.revisitQueue[0].headline).toContain("broke support");
  });
});

describe("approaching display cap", () => {
  it("caps the list but reports the true total", () => {
    // A 500-alert book puts ~100 names within a few percent; the display
    // must not silently drop the rest.
    const alerts = Array.from({ length: 30 }, (_, i) =>
      staticAlert({ id: `a${i}`, symbol: `S${i}`, level: 100 + i * 0.01 })
    );
    const quoteMap = Object.fromEntries(alerts.map((a) => [a.symbol, 100]));
    const d = base({ alerts, quotes: quotes(quoteMap), limit: 5, approachingWithinPct: 50, includeApproaching: true });
    expect(d.approaching).toHaveLength(5);
    expect(d.approachingTotal).toBe(30);
    expect(renderDashboard(d)).toContain("nearest 5 of 30");
  });

  it("says nothing about a total when nothing was trimmed", () => {
    const d = base({ alerts: [staticAlert({ level: 101 })], quotes: quotes({ AAPL: 100 }), includeApproaching: true });
    expect(d.approachingTotal).toBe(1);
    expect(renderDashboard(d)).not.toContain(" of 1 within range");
  });

  it("shows the side in the arrow so a downside alert is unambiguous", () => {
    const d = base({
      alerts: [staticAlert({ side: "below", level: 90.4, lastKnownSide: "above" })],
      quotes: quotes({ AAPL: 90.48 }),
      includeApproaching: true,
    });
    expect(renderDashboard(d)).toContain("90.48 ↓ 90.4");
  });
});

describe("approaching is off by default", () => {
  it("omits the section entirely unless asked for", () => {
    // On a 500-alert book a hundred names sit within a few percent at any
    // moment; that is market noise, not a to-do list.
    const d = base({ alerts: [staticAlert({ level: 101 })], quotes: quotes({ AAPL: 100 }) });
    expect(d.approaching).toEqual([]);
    expect(d.approachingTotal).toBe(0);
    expect(renderDashboard(d)).not.toContain("APPROACHING");
  });

  it("still counts a missing quote as missing coverage when off", () => {
    // The quote sweep drives the summary regardless of whether the list renders.
    const d = base({ alerts: [staticAlert()], quotes: new Map() });
    expect(d.summary.quotesUnavailable).toBe(1);
  });

  it("renders the section when opted in", () => {
    const d = base({ alerts: [staticAlert({ level: 101 })], quotes: quotes({ AAPL: 100 }), includeApproaching: true });
    expect(renderDashboard(d)).toContain("APPROACHING");
  });
});
