/**
 * Holdings, and the stories that tell your trades, for the unlocked page, encrypted.
 *
 * The site is public (no login), and share counts, basis, value, and stops
 * must never be readable on it (see siteDocument). The page still needs them
 * once editing is unlocked, and it already holds a secret by then: the ops
 * token. So holdings are published as vault.json, AES-256-GCM encrypted under
 * a key derived from that token, and the page decrypts them in the browser.
 *
 * The token is 256 random bits, so a plain SHA-256 with a context prefix is
 * enough of a key derivation; there is no password to stretch. The browser
 * side (web/app.js, openVault) must derive the key the same way.
 *
 * Every seal uses a fresh IV, so the ciphertext changes on every build. The
 * publish fingerprint therefore covers the plaintext (vaultContents), never
 * this document.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Dashboard, HoldingRow } from "../dashboard.js";
import type { TickerStory } from "../narrative.js";
import type { Holding, HoldingsStore, Lot, Stop, WebullState } from "../holdings/models.js";
import type { SpreadStopsStore } from "../spreads/spreadStops.js";

export const VAULT_FILE = "vault.json";

const KEY_CONTEXT = "equity-watch/holdings-vault/v1 ";
const TAG_BYTES = 16;

export interface VaultContents {
  /** The dashboard's position rows, with live prices. */
  holdings: HoldingRow[];
  /** createdAt breaks a same-day tie in the order a sale takes lots (saleOrder), which the page previews. */
  lots: Pick<Lot, "id" | "symbol" | "count" | "basisPerShare" | "purchaseDate" | "createdAt" | "account">[];
  /** `webull` on a stop that is a real Webull order (absent before phase 3). */
  stops: Pick<Stop, "id" | "symbol" | "count" | "stopPrice" | "webull">[];
  /**
   * Stories tell when you bought and sold, so they travel here and never in
   * dashboard.json (siteDocument empties them). Absent in vaults sealed before
   * 2026-09-25.
   */
  stories: TickerStory[];
  /**
   * Each live spread stop's OptionStrat saved trade, by stop key. The trade shows
   * the quantity, so the link is a size fact and travels only here. Absent in
   * vaults sealed before 2026-10-24.
   */
  spreadLinks?: Record<string, string>;
  /**
   * Who keeps each holding (docs/WEBULL_SYNC_PLAN.md), without the sync's
   * booking map, which the page has no use for. Absent before the Webull sync.
   */
  holdingSources?: Pick<Holding, "account" | "symbol" | "source" | "ignored">[];
  /** The last Webull read: cash per account, unmatched and linkable positions, flags. Absent until the first sync. */
  webull?: WebullState;
  /**
   * Whether the order path is on, and its limits, so the page offers order
   * controls only when they can work (src/orders/config.ts). The watcher checks
   * everything again; this is only what to show.
   */
  orders?: { enabled: boolean; maxValue: number; maxPerDay: number; accounts: string[] | null };
}

export interface VaultDocument {
  v: 1;
  alg: "AES-GCM";
  /** 12-byte IV, base64. */
  iv: string;
  /** Ciphertext followed by the 16-byte GCM tag, base64: the layout WebCrypto's decrypt expects. */
  data: string;
}

export function vaultKey(token: string): Buffer {
  return createHash("sha256").update(KEY_CONTEXT + token).digest();
}

export function vaultContents(
  dashboard: Pick<Dashboard, "holdings" | "stories">,
  store: HoldingsStore,
  spreadStops?: SpreadStopsStore,
  orders?: VaultContents["orders"]
): VaultContents {
  const links: [string, string][] = (spreadStops?.stops ?? []).flatMap((s) =>
    s.status === "live" && s.spread.optionStratUrl ? [[s.key, s.spread.optionStratUrl] as [string, string]] : []
  );
  return {
    holdings: dashboard.holdings,
    lots: store.lots.map(({ id, symbol, count, basisPerShare, purchaseDate, createdAt, account }) => ({
      id,
      symbol,
      count,
      basisPerShare,
      purchaseDate,
      createdAt,
      ...(account !== undefined ? { account } : {}),
    })),
    stops: store.stops.map(({ id, symbol, count, stopPrice, webull }) => ({ id, symbol, count, stopPrice, ...(webull ? { webull } : {}) })),
    stories: dashboard.stories,
    ...(links.length > 0 ? { spreadLinks: Object.fromEntries(links) } : {}),
    ...(store.holdings !== undefined && store.holdings.length > 0
      ? { holdingSources: store.holdings.map(({ account, symbol, source, ignored }) => ({ account, symbol, source, ...(ignored ? { ignored } : {}) })) }
      : {}),
    ...(store.webull !== undefined ? { webull: webullForPage(store.webull) } : {}),
    ...(orders !== undefined ? { orders } : {}),
  };
}

/** The state minus each entry's booking map: the page never needs order ids it can't act on. */
function webullForPage(state: WebullState): WebullState {
  return {
    ...state,
    accounts: state.accounts.map((a) => ({
      ...a,
      unmatched: a.unmatched.map((u) => ({ ...u, booked: {} })),
      links: a.links.map((l) => ({ ...l, booked: {} })),
    })),
  };
}

export function sealVault(contents: VaultContents, token: string, iv: Buffer = randomBytes(12)): VaultDocument {
  return sealJson(contents, token, iv);
}

/** Any value, sealed the vault's way: what orders.json uses too, so the page opens both with one key. */
export function sealJson(value: unknown, token: string, iv: Buffer = randomBytes(12)): VaultDocument {
  const cipher = createCipheriv("aes-256-gcm", vaultKey(token), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, alg: "AES-GCM", iv: iv.toString("base64"), data: body.toString("base64") };
}

/** Throws on a wrong token or a tampered document (GCM authenticates). */
export function openVault(doc: VaultDocument, token: string): VaultContents {
  const body = Buffer.from(doc.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(token), Buffer.from(doc.iv, "base64"));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as VaultContents;
}
