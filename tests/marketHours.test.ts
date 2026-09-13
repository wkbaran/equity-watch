import { describe, expect, it } from "vitest";
import {
  EXTENDED_SESSIONS,
  REGULAR_SESSIONS,
  isPollable,
  marketDate,
  msUntilNextSession,
  parseMarketHours,
  reviveMarketHours,
  sessionAt,
} from "../src/marketHours.js";

// Real responses captured from Schwab's /marketdata/v1/markets on 2026-09-12.
const OPEN_DAY = {
  equity: {
    EQ: {
      date: "2026-09-14",
      marketType: "EQUITY",
      product: "EQ",
      isOpen: true,
      sessionHours: {
        preMarket: [{ start: "2026-09-14T07:00:00-04:00", end: "2026-09-14T09:30:00-04:00" }],
        regularMarket: [{ start: "2026-09-14T09:30:00-04:00", end: "2026-09-14T16:00:00-04:00" }],
        postMarket: [{ start: "2026-09-14T16:00:00-04:00", end: "2026-09-14T20:00:00-04:00" }],
      },
    },
  },
};

// Note the different product key when closed - "equity", not "EQ".
const CLOSED_DAY = {
  equity: { equity: { date: "2026-09-12", marketType: "EQUITY", product: "equity", isOpen: false } },
};

// Black Friday: regular session ends 13:00, post-market ends 17:00.
const HALF_DAY = {
  equity: {
    EQ: {
      date: "2026-11-27",
      isOpen: true,
      sessionHours: {
        preMarket: [{ start: "2026-11-27T07:00:00-05:00", end: "2026-11-27T09:30:00-05:00" }],
        regularMarket: [{ start: "2026-11-27T09:30:00-05:00", end: "2026-11-27T13:00:00-05:00" }],
        postMarket: [{ start: "2026-11-27T13:00:00-05:00", end: "2026-11-27T17:00:00-05:00" }],
      },
    },
  },
};

describe("parseMarketHours", () => {
  it("reads the product whichever key Schwab used", () => {
    // The key is "EQ" when open and "equity" when closed - reading either
    // literal would break on half the days of the year.
    expect(parseMarketHours(OPEN_DAY, "2026-09-14").isOpen).toBe(true);
    expect(parseMarketHours(CLOSED_DAY, "2026-09-12").isOpen).toBe(false);
  });

  it("returns a closed day rather than throwing on junk", () => {
    for (const junk of [null, undefined, {}, { equity: {} }, "nope", 42]) {
      expect(parseMarketHours(junk, "2026-01-01").isOpen).toBe(false);
    }
  });

  it("keeps the three sessions separate", () => {
    const h = parseMarketHours(OPEN_DAY, "2026-09-14");
    expect(h.preMarket).toHaveLength(1);
    expect(h.regularMarket).toHaveLength(1);
    expect(h.postMarket).toHaveLength(1);
  });
});

describe("sessionAt", () => {
  const open = parseMarketHours(OPEN_DAY, "2026-09-14");

  it("classifies each session", () => {
    expect(sessionAt(open, new Date("2026-09-14T08:00:00-04:00"))).toBe("pre");
    expect(sessionAt(open, new Date("2026-09-14T12:00:00-04:00"))).toBe("regular");
    expect(sessionAt(open, new Date("2026-09-14T17:00:00-04:00"))).toBe("post");
    expect(sessionAt(open, new Date("2026-09-14T22:00:00-04:00"))).toBe("closed");
    expect(sessionAt(open, new Date("2026-09-14T03:00:00-04:00"))).toBe("closed");
  });

  it("resolves a boundary instant to the more significant session", () => {
    // Schwab reports preMarket ending exactly where regularMarket starts.
    expect(sessionAt(open, new Date("2026-09-14T09:30:00-04:00"))).toBe("regular");
    // And regularMarket ending exactly where postMarket starts.
    expect(sessionAt(open, new Date("2026-09-14T16:00:00-04:00"))).toBe("post");
  });

  it("reports closed all day when the market is closed", () => {
    const closed = parseMarketHours(CLOSED_DAY, "2026-09-12");
    expect(sessionAt(closed, new Date("2026-09-12T12:00:00-04:00"))).toBe("closed");
    expect(sessionAt(null, new Date())).toBe("closed");
  });

  it("respects a half day's early close instead of assuming 16:00", () => {
    // The whole reason hours come from the API rather than a constant.
    const half = parseMarketHours(HALF_DAY, "2026-11-27");
    expect(sessionAt(half, new Date("2026-11-27T12:00:00-05:00"))).toBe("regular");
    expect(sessionAt(half, new Date("2026-11-27T14:00:00-05:00"))).toBe("post");
    expect(sessionAt(half, new Date("2026-11-27T18:00:00-05:00"))).toBe("closed");
  });
});

describe("polling gates", () => {
  const open = parseMarketHours(OPEN_DAY, "2026-09-14");

  it("extended polling accepts pre and post, regular-only does not", () => {
    expect(isPollable("pre", EXTENDED_SESSIONS)).toBe(true);
    expect(isPollable("post", EXTENDED_SESSIONS)).toBe(true);
    expect(isPollable("pre", REGULAR_SESSIONS)).toBe(false);
    expect(isPollable("regular", REGULAR_SESSIONS)).toBe(true);
  });

  it("never polls when closed, under either policy", () => {
    expect(isPollable("closed", EXTENDED_SESSIONS)).toBe(false);
    expect(isPollable("closed", REGULAR_SESSIONS)).toBe(false);
  });

  it("reports the wait until the next session opens", () => {
    const at6am = new Date("2026-09-14T06:00:00-04:00");
    expect(msUntilNextSession(open, at6am, EXTENDED_SESSIONS)).toBe(60 * 60_000); // pre opens at 07:00
    expect(msUntilNextSession(open, at6am, REGULAR_SESSIONS)).toBe(3.5 * 60 * 60_000); // regular at 09:30
  });

  it("returns null once the day's sessions are behind us", () => {
    expect(msUntilNextSession(open, new Date("2026-09-14T21:00:00-04:00"), EXTENDED_SESSIONS)).toBeNull();
    expect(msUntilNextSession(null, new Date(), EXTENDED_SESSIONS)).toBeNull();
  });
});

describe("cache round-trip", () => {
  it("survives JSON serialisation with working Date comparisons", () => {
    const original = parseMarketHours(OPEN_DAY, "2026-09-14");
    const revived = reviveMarketHours(JSON.parse(JSON.stringify(original)))!;
    expect(revived.isOpen).toBe(true);
    expect(sessionAt(revived, new Date("2026-09-14T12:00:00-04:00"))).toBe("regular");
  });

  it("rejects a corrupt cache file instead of silently reporting closed", () => {
    expect(reviveMarketHours({ garbage: true })).toBeNull();
    expect(reviveMarketHours("nope")).toBeNull();
  });
});

describe("marketDate", () => {
  it("uses the US/Eastern calendar date, not the local one", () => {
    // 01:00 UTC on the 15th is still the 14th in New York; asking for the
    // wrong date would fetch the wrong day's hours.
    expect(marketDate(new Date("2026-09-15T01:00:00Z"))).toBe("2026-09-14");
    expect(marketDate(new Date("2026-09-14T20:00:00Z"))).toBe("2026-09-14");
  });
});
