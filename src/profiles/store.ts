/**
 * On-disk cache for company profiles - one JSON file per symbol, same
 * convention as .cache/beta/ (src/cli.ts's buildBetaFetcher). No expiry by
 * default, since sector/industry/description barely change.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompanyInfo } from "../dashboard.js";
import type { CompanyProfile } from "../providers/fmp.js";

function profileFile(cacheDir: string, symbol: string): string {
  return join(cacheDir, `${symbol.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadCachedProfile(cacheDir: string, symbol: string): CompanyProfile | null {
  const file = profileFile(cacheDir, symbol);
  if (!existsSync(file)) {
    return null;
  }
  return JSON.parse(readFileSync(file, "utf-8")) as CompanyProfile;
}

/**
 * Whether `profile fetch` should call FMP for a symbol. A profile cached before
 * the exchange was recorded counts as missing, since chart links need it; one
 * where FMP had no exchange (`null`) does not, or it would be refetched forever.
 */
export function profileNeedsFetch(cached: CompanyProfile | null, refresh: boolean): boolean {
  return refresh || cached === null || cached.exchange === undefined;
}

export function saveCachedProfile(cacheDir: string, profile: CompanyProfile): void {
  const file = profileFile(cacheDir, profile.symbol);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(profile, null, 2));
}

/**
 * Symbol to company name and sector, for the dashboard document.
 *
 * Deliberately drops `description`: it is a paragraph per symbol, and the
 * document is polled every minute by every open tab. Name and sector are what
 * a row can show.
 */
export function companyInfoFromProfiles(profiles: CompanyProfile[]): Map<string, CompanyInfo> {
  return new Map(profiles.map((p) => [p.symbol, { name: p.companyName, sector: p.sector, industry: p.industry }]));
}

export function listCachedProfiles(cacheDir: string): CompanyProfile[] {
  if (!existsSync(cacheDir)) {
    return [];
  }
  return readdirSync(cacheDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => JSON.parse(readFileSync(join(cacheDir, f), "utf-8")) as CompanyProfile);
}
