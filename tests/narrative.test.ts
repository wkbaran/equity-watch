import { describe, expect, it } from "vitest";
import {
  buildStories,
  quietWatchNote,
  sinceWatchingNote,
  tickerStory,
  triggerAction,
  triggerHeadline,
} from "../src/narrative.js";
import { scoreRevisit, type RevisitEntry } from "../src/alerts/revisit.js";

const NONE = { heldSymbols: new Set<string>() };
const HELD = { heldSymbols: new Set(["MKS"]) };

function entry(overrides: Partial<RevisitEntry> = {}): RevisitEntry {
  return {
    id: "r1",
    alertId: "a1",
    symbol: "TGT",
    kind: "static",
    triggeredAt: "2026-09-10T14:00:00.000Z",
    triggerPrice: 112,
    levelAtTrigger: 110,
    session: "regular",
    watchingSince: null,
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    status: "open",
    suggestedLevel: null,
    suggestedAt: null,
    suggestionBasis: null,
    resolvedAt: null,
    appliedFrom: null,
    appliedTo: null,
    priority: null,
    signals: null,
    ...overrides,
  };
}

function withSignals(overrides: Partial<RevisitEntry>, signalInputs: Parameters<typeof scoreRevisit>[0]): RevisitEntry {
  const { priority, signals } = scoreRevisit(signalInputs);
  return entry({ ...overrides, priority, signals });
}

describe("triggerHeadline for moving-average triggers", () => {
  const ma = (overrides: Partial<NonNullable<RevisitEntry["ma"]>>) =>
    entry({
      kind: "ma",
      levelAtTrigger: 200.5,
      triggerPrice: 201,
      ma: { maType: "sma", period: 200, timeframe: "1W", event: "cross_up", approachedFrom: "below", ...overrides },
    });

  it("names the average and what price did against it", () => {
    expect(triggerHeadline(ma({}), NONE)).toBe("TGT crossed above its 200-week SMA");
    expect(triggerHeadline(ma({ event: "cross_down", approachedFrom: "above" }), NONE)).toBe(
      "TGT crossed below its 200-week SMA"
    );
  });

  it("says which side a touch came from, and keeps the held and session qualifiers", () => {
    const touch = { ...ma({ maType: "ema", period: 9, timeframe: "5m", event: "touch", approachedFrom: "above" }), symbol: "MKS", session: "pre" as const };
    expect(triggerHeadline(touch, HELD)).toBe("Holding MKS touched its 9-bar EMA on 5-minute bars from above, in pre-market");
  });

  it("never borrows breakout language, whatever the verdict says", () => {
    const scored = withSignals(
      { kind: "ma", ma: { maType: "sma", period: 20, timeframe: "1D", event: "cross_up", approachedFrom: "below" } },
      { verdict: "CONFIRMED_BREAKOUT", pctMovePastLevel: 4, daysOpen: 0, heldPosition: false, volumeRatio: 3, volumeTrendRatio: 2 }
    );
    expect(triggerHeadline(scored, NONE)).toBe("TGT crossed above its 20-day SMA");
  });
});

describe("triggerHeadline", () => {
  it("says what the user asked for: broke resistance with volume", () => {
    const e = withSignals({}, {
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 4,
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.3,
      volumeTrendRatio: 1.5,
    });
    expect(triggerHeadline(e, NONE)).toBe("TGT broke resistance with volume, now 4.0% above it");
  });

  it("says holding X broke support for a downside move on a position", () => {
    const e = withSignals({ symbol: "MKS", levelAtTrigger: 110, triggerPrice: 104 }, {
      verdict: "WATCH",
      pctMovePastLevel: -5.5,
      daysOpen: 0,
      heldPosition: true,
      volumeRatio: 1.8,
      volumeTrendRatio: 1.2,
    });
    expect(triggerHeadline(e, HELD)).toBe("Holding MKS broke support, now 5.5% below it");
  });

  it("does not claim a breakout when the close never confirmed", () => {
    const e = withSignals({}, {
      verdict: "NO_CLOSE_CONFIRM",
      pctMovePastLevel: 0.2,
      daysOpen: 1,
      heldPosition: false,
      volumeRatio: 1.1,
    });
    expect(triggerHeadline(e, NONE)).toContain("tagged its level intraday but closed back below");
    expect(triggerHeadline(e, NONE)).not.toContain("broke resistance");
  });

  it("distinguishes a volume-confirmed push from a thin one", () => {
    const thin = withSignals({}, { verdict: "WATCH_WEAK", daysOpen: 0, heldPosition: false, volumeRatio: 1.0 });
    const thick = withSignals({}, {
      verdict: "WATCH_WEAK",
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.5,
      volumeTrendRatio: 1.6,
    });
    expect(triggerHeadline(thin, NONE)).toContain("thin volume");
    expect(triggerHeadline(thick, NONE)).toContain("on volume");
  });

  it("flags an extended-hours trigger so it reads differently", () => {
    const e = withSignals({ session: "pre" }, {
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 3,
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.2,
      volumeTrendRatio: 1.4,
    });
    expect(triggerHeadline(e, NONE)).toContain("in pre-market");
  });

  it("stays silent about the session during regular hours", () => {
    const e = withSignals({ session: "regular" }, {
      verdict: "CONFIRMED_BREAKOUT",
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.2,
      volumeTrendRatio: 1.4,
    });
    expect(triggerHeadline(e, NONE)).not.toContain("regular hours");
  });

  it("handles a volume-only trigger, which has no level to describe", () => {
    expect(triggerHeadline(entry({ kind: "volume", levelAtTrigger: null }), NONE)).toBe("TGT traded unusual volume");
  });

  it("omits a sub-1% move rather than reporting noise", () => {
    const e = withSignals({}, { verdict: "WATCH", pctMovePastLevel: 0.3, daysOpen: 0, heldPosition: false });
    expect(triggerHeadline(e, NONE)).not.toContain("0.3%");
  });
});

describe("triggerAction", () => {
  it("proposes the move when a level has been suggested", () => {
    expect(triggerAction(entry({ suggestedLevel: 118 }))).toBe("Suggest moving 110 to 118.");
  });

  it("says the level stands when nothing was suggested", () => {
    expect(triggerAction(entry())).toBe("Level 110 still stands.");
  });

  it("has nothing to say about a dismissed entry", () => {
    expect(triggerAction(entry({ status: "dismissed" }))).toBeNull();
  });
});

describe("tickerStory", () => {
  it("threads repeated triggers and the re-levels between them", () => {
    const story = tickerStory(
      "CTVA",
      [
        entry({ id: "1", symbol: "CTVA", triggeredAt: "2026-08-20T13:53:00Z", levelAtTrigger: 82.1, triggerPrice: 83, status: "applied", appliedFrom: 82.1, appliedTo: 84.2, resolvedAt: "2026-08-21T13:00:00Z" }),
        entry({ id: "2", symbol: "CTVA", triggeredAt: "2026-08-26T11:50:00Z", levelAtTrigger: 84.2, triggerPrice: 85, status: "applied", appliedFrom: 84.2, appliedTo: 86, resolvedAt: "2026-08-27T13:00:00Z" }),
        entry({ id: "3", symbol: "CTVA", triggeredAt: "2026-09-01T11:30:00Z", levelAtTrigger: 86, triggerPrice: 88, status: "open" }),
      ],
      NONE
    );
    expect(story.summary).toContain("fired 3 times");
    expect(story.summary).toContain("walking its level from 82.1 up to 86");
    expect(story.summary).toContain("1 still open");
    expect(story.lines.some((l) => l.text.includes("you raised the level 82.1 to 84.2"))).toBe(true);
  });

  it("records a dismissal as a decision, not an absence", () => {
    const story = tickerStory(
      "GO",
      [entry({ symbol: "GO", status: "dismissed", resolvedAt: "2026-09-11T13:00:00Z" })],
      NONE
    );
    expect(story.lines.some((l) => l.text.includes("you left the level where it was"))).toBe(true);
  });

  it("keeps beats in chronological order regardless of input order", () => {
    const story = tickerStory(
      "X",
      [
        entry({ id: "b", symbol: "X", triggeredAt: "2026-09-05T00:00:00Z" }),
        entry({ id: "a", symbol: "X", triggeredAt: "2026-09-01T00:00:00Z" }),
      ],
      NONE
    );
    expect(story.lines[0].at < story.lines[1].at).toBe(true);
  });

  it("reads sensibly for a single trigger", () => {
    const story = tickerStory("TGT", [entry()], NONE);
    expect(story.summary).toContain("fired once");
    expect(story.summary).toContain("still waiting on you");
  });
});

describe("buildStories", () => {
  const many = [
    entry({ id: "1", symbol: "CTVA", triggeredAt: "2026-08-20T13:00:00Z" }),
    entry({ id: "2", symbol: "CTVA", triggeredAt: "2026-08-26T13:00:00Z" }),
    entry({ id: "3", symbol: "CTVA", triggeredAt: "2026-09-01T13:00:00Z" }),
    entry({ id: "4", symbol: "MKS", triggeredAt: "2026-09-02T13:00:00Z" }),
    entry({ id: "5", symbol: "MKS", triggeredAt: "2026-09-03T13:00:00Z" }),
    entry({ id: "6", symbol: "ONCE", triggeredAt: "2026-09-04T13:00:00Z" }),
  ];

  it("only tells stories for tickers with a thread, not one-offs", () => {
    const stories = buildStories(many, NONE);
    expect(stories.map((s) => s.symbol).sort()).toEqual(["CTVA", "MKS"]);
  });

  it("puts positions ahead of watchlist names", () => {
    const stories = buildStories(many, HELD);
    expect(stories[0].symbol).toBe("MKS");
    expect(stories[0].held).toBe(true);
  });

  it("honours the limit", () => {
    expect(buildStories(many, NONE, { limit: 1 })).toHaveLength(1);
  });

  it("returns nothing when there is no history", () => {
    expect(buildStories([], NONE)).toEqual([]);
  });
});

describe("watch history", () => {
  const NOW = new Date("2026-09-12T12:00:00Z");

  it("says how far it has moved since you started watching", () => {
    expect(sinceWatchingNote("2026-07-16T12:00:00Z", 80, 92, false)).toBe(
      "Up 15% since you started watching it, July 2026."
    );
    expect(sinceWatchingNote("2026-07-16T12:00:00Z", 100, 91, false)).toBe(
      "Down 9.0% since you started watching it, July 2026."
    );
  });

  it("hedges the date for an imported alert whose real start is unknown", () => {
    expect(sinceWatchingNote("2026-02-24T12:00:00Z", 12, 14, true)).toContain("February 2026 or earlier");
  });

  it("states the date without a percentage when the old price is unrecoverable", () => {
    // A seeded alert whose start predates the bars fetched at import time.
    expect(sinceWatchingNote("2026-02-24T12:00:00Z", null, 14, true)).toBe("Watching since February 2026 or earlier.");
  });

  it("calls a flat name flat rather than reporting noise", () => {
    expect(sinceWatchingNote("2026-07-16T12:00:00Z", 100, 100.4, false)).toBe(
      "Flat since you started watching it, July 2026."
    );
  });

  it("says nothing when the watch start is unknown", () => {
    expect(sinceWatchingNote(null, 100, 120, false)).toBeNull();
  });

  const quiet = {
    symbol: "EMB",
    // Dormancy is measured from observedSince (when this system started),
    // not from the backdated interest date.
    observedSince: "2026-04-17T12:38:38Z",
    // An intraday timestamp, as a real trigger carries. A midnight-UTC value
    // would render as the previous day in US/Eastern.
    watchingSince: "2026-04-17T12:38:38Z",
    watchingSinceApprox: false,
    priceAtWatchStart: 95,
    currentPrice: 96,
    triggerCount: 0,
  };

  it("flags a long, motionless, untriggered watch", () => {
    const note = quietWatchNote(quiet, NOW)!;
    expect(note).toContain("EMB");
    expect(note).toContain("04/17/26");
    expect(note).toContain("nothing in 147d");
    expect(note).toContain("up only 1.1%");
  });

  it("does not call a freshly imported alert dormant", () => {
    // The regression: an imported alert is backdated to the date it last fired
    // in TradingView, so measuring dormancy from there would announce that a
    // name has seen "nothing" on the strength of the very trigger that
    // supplied the date.
    const justImported = { ...quiet, watchingSinceApprox: true, observedSince: "2026-09-12T00:00:00Z" };
    expect(quietWatchNote(justImported, NOW)).toBeNull();
  });

  it("stays quiet about a name that has actually moved", () => {
    // It hasn't crossed its level, but it isn't dead - that's a working alert.
    expect(quietWatchNote({ ...quiet, currentPrice: 130 }, NOW)).toBeNull();
  });

  it("stays quiet about anything that has ever fired", () => {
    expect(quietWatchNote({ ...quiet, triggerCount: 1 }, NOW)).toBeNull();
  });

  it("stays quiet about a recently added watch", () => {
    expect(quietWatchNote({ ...quiet, observedSince: "2026-09-01T00:00:00Z" }, NOW)).toBeNull();
  });

  it("still reports a quiet watch when the old price is unknown", () => {
    const note = quietWatchNote({ ...quiet, priceAtWatchStart: null }, NOW)!;
    expect(note).toContain("nothing in 147d");
    expect(note).not.toContain("only");
  });

  it("opens a story with when watching began, when that predates the first trigger", () => {
    const story = tickerStory(
      "CTVA",
      [
        entry({ symbol: "CTVA", triggeredAt: "2026-08-20T13:00:00Z", watchingSince: "2026-06-01T00:00:00Z", watchingSinceApprox: true }),
        entry({ id: "2", symbol: "CTVA", triggeredAt: "2026-09-01T13:00:00Z", watchingSince: "2026-06-01T00:00:00Z", watchingSinceApprox: true }),
      ],
      NONE
    );
    expect(story.lines[0].text).toContain("you started watching CTVA (or earlier)");
  });
});
