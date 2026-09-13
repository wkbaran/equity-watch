/**
 * One-time transform of Webull holdings exports into lots.
 *
 * Like src/alerts/seed.ts, this is deliberately NOT a general importer. Webull
 * does not officially support this export, so the format carries no guarantee
 * and is known to be internally inconsistent - see `reconcileQuantity`.
 *
 *   Symbol, Name, Quantity, Market Value, Open P&L, Open P&L %, Day's P&L,
 *   Last Price, Avg Cost, Total Cost, Position Ratio %, Product Type
 *
 * Two things the export does not carry, both of which matter downstream:
 *   - **No purchase date.** The "stagnant" holdings alert keys off days since
 *     the last purchase, so imported lots need a date supplied, and every
 *     position will look freshly bought until it ages past the threshold.
 *   - **No account.** Each file is one account, so the caller labels it; the
 *     same symbol can legitimately appear in two files (BIL does).
 */

import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";

export interface ImportedLot {
  symbol: string;
  name: string;
  account: string;
  count: number;
  basisPerShare: number;
  /** Straight from the file, for the reconciliation report. */
  statedQuantity: number;
  marketValue: number;
  lastPrice: number;
  openPnlPct: number;
}

export interface ImportSkip {
  symbol: string;
  account: string;
  reason: string;
}

export interface ImportWarning {
  symbol: string;
  account: string;
  message: string;
}

export interface HoldingsImportPlan {
  lots: ImportedLot[];
  skipped: ImportSkip[];
  warnings: ImportWarning[];
  rowsRead: number;
}

function num(raw: string | undefined): number {
  const parsed = parseFloat(String(raw ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export interface QuantityReconciliation {
  count: number;
  /** Set when the file's own Quantity column disagrees with the derived share count. */
  disagreement: string | null;
}

/**
 * Webull's `Quantity` column cannot be trusted on its own: in the 2026-09-11
 * exports, EMN says 3 shares and OMF says 9, while *both* `Market Value /
 * Last Price` and `Total Cost / Avg Cost` independently say 5 and 6.
 *
 * Total Cost / Avg Cost wins, because it is the pair that defines the cost
 * basis every holdings alert is computed against. Market Value / Last Price
 * is used only as a cross-check, since rounding in Last Price makes it
 * fractionally noisy (a 341-share position divides to 340.80).
 */
export function reconcileQuantity(
  statedQuantity: number,
  marketValue: number,
  lastPrice: number,
  totalCost: number,
  avgCost: number
): QuantityReconciliation {
  const fromCost = avgCost > 0 ? totalCost / avgCost : NaN;
  const fromMarket = lastPrice > 0 ? marketValue / lastPrice : NaN;

  if (!Number.isFinite(fromCost)) {
    return { count: statedQuantity, disagreement: null };
  }

  const derived = Math.round(fromCost);
  // Only trust the override when the independent market-value figure agrees,
  // so a single bad cell can't silently rewrite a position.
  const corroborated = Number.isFinite(fromMarket) && Math.abs(Math.round(fromMarket) - derived) < 1;

  if (Math.abs(statedQuantity - derived) < 0.51 || !corroborated) {
    return { count: statedQuantity, disagreement: null };
  }
  return {
    count: derived,
    disagreement:
      `file says ${statedQuantity} shares, but Total Cost/Avg Cost and ` +
      `Market Value/Last Price both say ${derived}; using ${derived}`,
  };
}

export function parseWebullHoldings(path: string, account: string): HoldingsImportPlan {
  const rows = parseCsv(readFileSync(path, "utf-8"), { columns: true, bom: true, skip_empty_lines: true }) as Record<
    string,
    string
  >[];

  const lots: ImportedLot[] = [];
  const skipped: ImportSkip[] = [];
  const warnings: ImportWarning[] = [];

  for (const row of rows) {
    const symbol = (row["Symbol"] ?? "").trim();
    if (!symbol) {
      continue;
    }
    const productType = (row["Product Type"] ?? "").trim();

    if (productType !== "Stock") {
      skipped.push({
        symbol,
        account,
        // The symbol is truncated in the export ("DPRO $5..."), so the contract
        // can't be reconstructed even if options were modelled.
        reason: `${productType || "unknown"} position — this system models shares only, and the export truncates the contract symbol`,
      });
      continue;
    }

    const avgCost = num(row["Avg Cost"]);
    const totalCost = num(row["Total Cost"]);
    const lastPrice = num(row["Last Price"]);
    const marketValue = num(row["Market Value"]);
    const statedQuantity = num(row["Quantity"]);

    if (!Number.isFinite(avgCost) || avgCost <= 0 || !Number.isFinite(statedQuantity)) {
      skipped.push({ symbol, account, reason: "missing or unusable Avg Cost / Quantity" });
      continue;
    }

    const { count, disagreement } = reconcileQuantity(statedQuantity, marketValue, lastPrice, totalCost, avgCost);
    if (disagreement !== null) {
      warnings.push({ symbol, account, message: disagreement });
    }
    if (count <= 0) {
      skipped.push({ symbol, account, reason: "resolved to zero shares" });
      continue;
    }

    lots.push({
      symbol: symbol.toUpperCase(),
      name: (row["Name"] ?? "").trim(),
      account,
      count,
      basisPerShare: avgCost,
      statedQuantity,
      marketValue,
      lastPrice,
      openPnlPct: num(row["Open P&L %"]),
    });
  }

  return { lots, skipped, warnings, rowsRead: rows.length };
}

/** Merges per-file plans and flags symbols that appear in more than one account. */
export function mergeImportPlans(plans: HoldingsImportPlan[]): HoldingsImportPlan {
  const merged: HoldingsImportPlan = { lots: [], skipped: [], warnings: [], rowsRead: 0 };
  for (const plan of plans) {
    merged.lots.push(...plan.lots);
    merged.skipped.push(...plan.skipped);
    merged.warnings.push(...plan.warnings);
    merged.rowsRead += plan.rowsRead;
  }

  const bySymbol = new Map<string, ImportedLot[]>();
  for (const lot of merged.lots) {
    bySymbol.set(lot.symbol, [...(bySymbol.get(lot.symbol) ?? []), lot]);
  }
  for (const [symbol, lots] of bySymbol) {
    if (lots.length > 1) {
      merged.warnings.push({
        symbol,
        account: lots.map((l) => l.account).join("+"),
        message:
          `held in ${lots.length} accounts (${lots
            .map((l) => `${l.account} ${l.count}@${l.basisPerShare}`)
            .join(", ")}); kept as separate lots but basis and alerts blend across both`,
      });
    }
  }
  return merged;
}
