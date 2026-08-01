/**
 * Market data provider interface.
 *
 * Only a Schwab implementation ships here (Schwab is the one official,
 * documented API among the user's brokerage accounts - Robinhood and Webull
 * only have unofficial reverse-engineered client libraries, which is a poor
 * fit for anything you want to rely on for historical OHLCV data). This
 * interface exists so another provider can be dropped in later without
 * touching analysis.ts or cli.ts.
 */

import type { PriceBar } from "../models.js";

export interface PriceDataProvider {
  getDailyBars(symbol: string, start: Date, end: Date): Promise<PriceBar[]>;
}
