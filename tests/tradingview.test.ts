import { describe, expect, it } from "vitest";
import { exchangesFromProfiles, mapExchange, tradingViewUrl } from "../src/tradingview.js";

describe("mapExchange", () => {
  // The codes FMP's /stable/profile actually returned for fixture symbols on 2026-09-13.
  it("maps FMP's codes to TradingView prefixes", () => {
    expect(mapExchange("NASDAQ")).toBe("NASDAQ"); // GOOG, AGNC, SOFI
    expect(mapExchange("NYSE")).toBe("NYSE"); // PPL, CDRE, MKL
    // BIL, VFH, KRE are NYSE Arca ETFs. FMP says AMEX, and TradingView's prefix for them is AMEX too.
    expect(mapExchange("AMEX")).toBe("AMEX");
    expect(mapExchange("OTC")).toBe("OTC");
  });

  it("returns null for anything it doesn't recognise", () => {
    expect(mapExchange("PSX")).toBeNull();
    expect(mapExchange("")).toBeNull();
    expect(mapExchange(null)).toBeNull();
    expect(mapExchange(undefined)).toBeNull();
  });
});

describe("tradingViewUrl", () => {
  it("prefixes the exchange, so PPL opens PPL Corp rather than Pakistan Petroleum", () => {
    expect(tradingViewUrl("PPL", "NYSE")).toBe("https://www.tradingview.com/chart/?symbol=NYSE%3APPL");
    expect(tradingViewUrl("BIL", "AMEX")).toBe("https://www.tradingview.com/chart/?symbol=AMEX%3ABIL");
  });

  it("falls back to the bare symbol when the exchange is unknown", () => {
    expect(tradingViewUrl("GOOG", undefined)).toBe("https://www.tradingview.com/chart/?symbol=GOOG");
    expect(tradingViewUrl("GOOG", "XETR")).toBe("https://www.tradingview.com/chart/?symbol=GOOG");
  });
});

describe("exchangesFromProfiles", () => {
  it("skips profiles with no exchange, including ones cached before it was recorded", () => {
    const map = exchangesFromProfiles([
      { symbol: "PPL", companyName: null, sector: null, industry: null, description: null, exchange: "NYSE" },
      { symbol: "ZZZ", companyName: null, sector: null, industry: null, description: null, exchange: null },
      { symbol: "AAPL", companyName: null, sector: null, industry: null, description: null },
    ]);
    expect(map).toEqual(new Map([["PPL", "NYSE"]]));
  });
});
