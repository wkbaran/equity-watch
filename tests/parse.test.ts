import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAlerts } from "../src/parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "sample_alerts.csv");

describe("parseAlerts", () => {
  it("parses all rows", () => {
    const alerts = parseAlerts(FIXTURE);
    expect(alerts).toHaveLength(6);
  });

  it("parses a plain price cross", () => {
    const alerts = parseAlerts(FIXTURE);
    const goog = alerts.find((a) => a.symbol === "GOOG")!;
    expect(goog.exchange).toBe("BATS");
    expect(goog.timeframe).toBeNull();
    expect(goog.alertType).toBe("price_cross");
    expect(goog.level).toBe(350.28);
  });

  it("parses a price cross with a comma thousands separator", () => {
    const alerts = parseAlerts(FIXTURE);
    const mkl = alerts.find((a) => a.symbol === "MKL")!;
    expect(mkl.alertType).toBe("price_cross");
    expect(mkl.level).toBe(2003.72);
  });

  it("parses volume crosses with a mangled unit separator", () => {
    const alerts = parseAlerts(FIXTURE);
    const achc = alerts.find((a) => a.symbol === "ACHC")!;
    expect(achc.timeframe).toBe("1D");
    expect(achc.alertType).toBe("volume_cross");
    expect(achc.level).toBe(4_500_000);

    const abnb = alerts.find((a) => a.symbol === "ABNB")!;
    expect(abnb.alertType).toBe("volume_cross");
    expect(abnb.level).toBe(4_500_000);
  });

  it("parses trendline crosses with no level", () => {
    const alerts = parseAlerts(FIXTURE);
    const sui = alerts.find((a) => a.symbol === "SUI")!;
    expect(sui.alertType).toBe("trendline_cross");
    expect(sui.level).toBeNull();
  });

  it("does not misparse an MA strategy alert as a price cross", () => {
    const alerts = parseAlerts(FIXTURE);
    const cdre = alerts.find((a) => a.symbol === "CDRE")!;
    expect(cdre.alertType).toBe("ma_strategy");
    expect(cdre.level).toBeNull();
  });
});
