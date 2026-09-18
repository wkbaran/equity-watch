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
  it("says what price did against the level, naming it: crossed above 110 on volume and held", () => {
    const e = withSignals({}, {
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 4,
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.3,
      volumeTrendRatio: 1.5,
    });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed above 110 and closed above it on volume, now 4.0% above it");
  });

  it("drops the volume claim from a confirmed hold when volume wasn't the story", () => {
    const e = withSignals({}, { verdict: "CONFIRMED_BREAKOUT", daysOpen: 0, heldPosition: false, volumeRatio: 1.1 });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed above 110 and closed above it on volume");
  });

  it("says holding X crossed below the level for a downside move on a position", () => {
    const e = withSignals({ symbol: "MKS", levelAtTrigger: 110, triggerPrice: 104 }, {
      verdict: "WATCH",
      pctMovePastLevel: -5.5,
      daysOpen: 0,
      heldPosition: true,
      volumeRatio: 1.8,
      volumeTrendRatio: 1.2,
    });
    expect(triggerHeadline(e, HELD)).toBe(
      "Holding MKS crossed below 110 and closed below it on volume, but volume faded or it didn't hold, now 5.5% below it"
    );
  });

  it("prefers the recorded direction over the trigger price", () => {
    // A gap straight through: recorded as a downward cross even though the
    // stored price happens to sit on the level.
    const e = entry({ direction: "down", triggerPrice: 110, levelAtTrigger: 110 });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed below 110");
  });

  it("does not claim a completed move when the close never confirmed", () => {
    const e = withSignals({}, {
      verdict: "NO_CLOSE_CONFIRM",
      pctMovePastLevel: 0.2,
      daysOpen: 1,
      heldPosition: false,
      volumeRatio: 1.1,
    });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed above 110 intraday but closed back below");
    expect(triggerHeadline(e, NONE)).not.toContain("held");
  });

  it("mirrors no-close-confirm for a downward crossing", () => {
    const e = withSignals({ triggerPrice: 108 }, { verdict: "NO_CLOSE_CONFIRM", daysOpen: 1, heldPosition: false });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed below 110 intraday but closed back above");
  });

  it("names the recent low, not the high, for a weak downward crossing on volume", () => {
    const e = withSignals({ triggerPrice: 108 }, {
      verdict: "WATCH_WEAK",
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.5,
      volumeTrendRatio: 1.6,
    });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed below 110 on volume, well short of its recent low");
  });

  it("says only what was recorded when no verdict has been run", () => {
    expect(triggerHeadline(entry(), NONE)).toBe("TGT crossed above 110");
    const rising = withSignals({}, { daysOpen: 0, heldPosition: false, volumeRatio: 2.5, volumeTrendRatio: 1.6 });
    expect(triggerHeadline(rising, NONE)).toBe("TGT crossed above 110 on rising volume");
    const nothing = withSignals({}, { verdict: "NO", daysOpen: 0, heldPosition: false });
    expect(triggerHeadline(nothing, NONE)).toBe("TGT crossed above 110 with nothing confirming it");
  });

  it("never calls an alert level support or resistance, whatever the verdict or direction", () => {
    const verdicts = [null, "CONFIRMED_BREAKOUT", "WATCH", "WATCH_WEAK", "NO_CLOSE_CONFIRM", "NO", "INSUFFICIENT_DATA"];
    for (const verdict of verdicts) {
      for (const triggerPrice of [104, 116]) {
        for (const volumeRatio of [1, 2.5]) {
          const e = withSignals({ triggerPrice }, { verdict, daysOpen: 0, heldPosition: true, volumeRatio, volumeTrendRatio: 1.6 });
          const text = triggerHeadline(e, HELD) + triggerHeadline({ ...e, symbol: "MKS" }, HELD);
          expect(text).not.toMatch(/support|resistance|broke/i);
          expect(text).toContain("110");
        }
      }
    }
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
    expect(triggerHeadline(thin, NONE)).toBe("TGT crossed above 110 on thin volume");
    expect(triggerHeadline(thick, NONE)).toBe("TGT crossed above 110 on volume, well short of its recent high");
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

describe("triggerHeadline for reversals", () => {
  // The fire is Thursday 2026-09-10, 10:00 Eastern.
  const up = (at: string, price = 111) => ({ at, price, direction: "up" as const, session: "regular" as const });
  const down = (at: string, price = 109) => ({ at, price, direction: "down" as const, session: "regular" as const });
  const SAME_DAY = "2026-09-10T18:00:00.000Z";
  const NEXT_DAY = "2026-09-11T15:00:00.000Z";
  const MONDAY = "2026-09-14T15:00:00.000Z";

  it("says when price fell back through the level, in trading days", () => {
    expect(triggerHeadline(entry({ followUps: [down(SAME_DAY)] }), NONE)).toBe("TGT crossed above 110, then fell back below it the same day");
    expect(triggerHeadline(entry({ followUps: [down(NEXT_DAY)] }), NONE)).toBe("TGT crossed above 110, then fell back below it the next day");
    // Friday and Monday are trading days 1 and 2; the weekend doesn't count.
    expect(triggerHeadline(entry({ followUps: [down(MONDAY)] }), NONE)).toBe("TGT crossed above 110, then fell back below it 2 days later");
  });

  it("says so when price came back to the fired side afterwards", () => {
    const e = entry({ followUps: [down(SAME_DAY), up(NEXT_DAY)] });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed above 110, then fell back below it the same day and climbed back above it the next day");
  });

  it("mirrors the wording for a downward fire", () => {
    const e = entry({ symbol: "MKS", triggerPrice: 108, direction: "down", followUps: [up(NEXT_DAY)] });
    expect(triggerHeadline(e, HELD)).toBe("Holding MKS crossed below 110, then climbed back above it the next day");
  });

  it("counts many crossings rather than listing them", () => {
    const e = entry({ followUps: [down(SAME_DAY), up("2026-09-10T19:00:00.000Z"), down(NEXT_DAY), up(MONDAY)] });
    expect(triggerHeadline(e, NONE)).toBe(
      "TGT crossed above 110, then fell back below it the same day, crossing it 4 times in all, ending above it"
    );
  });

  it("doesn't repeat a same-day close back below that the verdict already states", () => {
    const scored = (followUps: RevisitEntry["followUps"]) =>
      withSignals({ followUps }, { verdict: "NO_CLOSE_CONFIRM", daysOpen: 0, heldPosition: false });
    expect(triggerHeadline(scored([down(SAME_DAY)]), NONE)).toBe("TGT crossed above 110 intraday but closed back below");
    expect(triggerHeadline(scored([down(SAME_DAY), up(NEXT_DAY)]), NONE)).toBe(
      "TGT crossed above 110 intraday but closed back below, then climbed back above it the next day"
    );
    // A reversal on a later day is new information and is still stated.
    expect(triggerHeadline(scored([down(NEXT_DAY)]), NONE)).toBe(
      "TGT crossed above 110 intraday but closed back below, then fell back below it the next day"
    );
  });

  it("leaves hold claims to the reversal rather than contradicting it", () => {
    const confirmed = withSignals({ followUps: [down(MONDAY)] }, {
      verdict: "CONFIRMED_BREAKOUT",
      daysOpen: 0,
      heldPosition: false,
      volumeRatio: 2.3,
      volumeTrendRatio: 1.5,
    });
    expect(triggerHeadline(confirmed, NONE)).toBe(
      "TGT crossed above 110 and closed above it on volume, then fell back below it 2 days later"
    );
    const watch = withSignals({ followUps: [down(NEXT_DAY)] }, { verdict: "WATCH", daysOpen: 0, heldPosition: false, pctMovePastLevel: -2 });
    expect(triggerHeadline(watch, NONE)).toBe(
      "TGT crossed above 110 and closed above it on volume, then fell back below it the next day, now 2.0% below it"
    );
  });

  it("keeps the session next to the fire, not after a reversal on another day", () => {
    const e = entry({ session: "pre", followUps: [down(NEXT_DAY)] });
    expect(triggerHeadline(e, NONE)).toBe("TGT crossed above 110, in pre-market, then fell back below it the next day");
  });

  it("says nothing about follow-ups that never went back", () => {
    // Not a realistic sequence, but a same-direction follow-up alone is no reversal.
    expect(triggerHeadline(entry({ followUps: [up(NEXT_DAY)] }), NONE)).toBe("TGT crossed above 110");
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

  // One edit closes every open entry for its alert, so two can carry one move.
  it("tells one edit once, and says lowered when it went down", () => {
    const moved = { status: "applied" as const, appliedFrom: 50, appliedTo: 45, resolvedAt: "2026-09-18T15:00:00Z" };
    const story = tickerStory(
      "ZZ",
      [
        entry({ id: "1", symbol: "ZZ", triggeredAt: "2026-09-16T14:00:00Z", ...moved }),
        entry({ id: "2", symbol: "ZZ", triggeredAt: "2026-09-17T14:00:00Z", ...moved }),
      ],
      NONE
    );
    expect(story.lines.filter((l) => l.text.includes("the level 50 to 45"))).toHaveLength(1);
    expect(story.lines.some((l) => l.text.includes("you lowered the level 50 to 45"))).toBe(true);
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

  it("skips legacy follow-up entries and tells reversals instead", () => {
    const followUps = [{ at: "2026-09-10T18:00:00.000Z", price: 109, direction: "down" as const, session: "regular" as const }];
    const story = tickerStory(
      "TGT",
      [
        entry({ id: "fire", followUps }),
        entry({ id: "echo", followUpOf: "fire", triggeredAt: "2026-09-10T18:00:00.000Z", triggerPrice: 109 }),
        entry({ id: "again", triggeredAt: "2026-09-12T14:00:00.000Z" }),
      ],
      NONE
    );
    expect(story.summary).toBe("TGT has fired 2 times since Sep 10, 1 of them reversed, with 2 still open.");
    expect(story.lines.map((l) => l.text)).toEqual([
      "Sep 10: TGT crossed above 110, then fell back below it the same day.",
      "Sep 12: TGT crossed above 110.",
    ]);
  });

  it("says a lone trigger reversed", () => {
    const followUps = [{ at: "2026-09-11T15:00:00.000Z", price: 109, direction: "down" as const, session: null }];
    expect(tickerStory("TGT", [entry({ followUps, status: "dismissed" })], NONE).summary).toBe("TGT fired once, Sep 10, then reversed.");
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

  it("doesn't let a legacy follow-up entry make a one-off look like a thread", () => {
    const echo = entry({ id: "7", symbol: "ONCE", followUpOf: "6", triggeredAt: "2026-09-04T15:00:00Z" });
    expect(buildStories([...many, echo], NONE).map((s) => s.symbol)).not.toContain("ONCE");
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
