/**
 * TradingView chart links.
 *
 * A bare `chart/?symbol=PPL` is ambiguous. TradingView resolves it to its own
 * top match, and its symbol search (checked 2026-09-13) ranks Pakistan
 * Petroleum on PSX above PPL Corp on NYSE; ENS, MKL, and GOOG have foreign
 * listings too. So a link carries an exchange prefix whenever the symbol's FMP
 * profile supplies one, mapped the same way uniquetrades-congress does, and
 * falls back to the bare symbol otherwise.
 */

import type { CompanyProfile } from "./providers/fmp.js";

/** FMP profile `exchange` to TradingView's symbol prefix. Null when unknown; TradingView then picks. */
export function mapExchange(exchange: string | null | undefined): string | null {
  if (!exchange) {
    return null;
  }
  const e = exchange.toUpperCase();
  if (e.includes("NASDAQ")) {
    return "NASDAQ";
  }
  // FMP reports NYSE Arca listings (BIL, VFH, KRE) as AMEX, which is also the
  // prefix TradingView gives them, so this isn't a mismatch.
  if (e.includes("AMEX") || e.includes("AMERICAN")) {
    return "AMEX";
  }
  if (e.startsWith("NYSE")) {
    return "NYSE";
  }
  if (e.includes("OTC") || e.includes("PINK")) {
    return "OTC";
  }
  if (e.includes("CBOE")) {
    return "CBOE";
  }
  return null;
}

export function tradingViewUrl(symbol: string, exchange: string | null | undefined): string {
  const prefix = mapExchange(exchange);
  const query = prefix ? `${prefix}:${symbol}` : symbol;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(query)}`;
}

/** Symbol to FMP exchange, for every cached profile that recorded one. */
export function exchangesFromProfiles(profiles: CompanyProfile[]): Map<string, string> {
  const exchanges = new Map<string, string>();
  for (const p of profiles) {
    if (p.exchange) {
      exchanges.set(p.symbol, p.exchange);
    }
  }
  return exchanges;
}
