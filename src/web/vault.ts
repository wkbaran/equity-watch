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
import type { HoldingsStore, Lot, Stop } from "../holdings/models.js";

export const VAULT_FILE = "vault.json";

const KEY_CONTEXT = "equity-watch/holdings-vault/v1 ";
const TAG_BYTES = 16;

export interface VaultContents {
  /** The dashboard's position rows, with live prices. */
  holdings: HoldingRow[];
  lots: Pick<Lot, "id" | "symbol" | "count" | "basisPerShare" | "purchaseDate" | "account">[];
  stops: Pick<Stop, "id" | "symbol" | "count" | "stopPrice">[];
  /**
   * Stories tell when you bought and sold, so they travel here and never in
   * dashboard.json (siteDocument empties them). Absent in vaults sealed before
   * 2026-09-25.
   */
  stories: TickerStory[];
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

export function vaultContents(dashboard: Pick<Dashboard, "holdings" | "stories">, store: HoldingsStore): VaultContents {
  return {
    holdings: dashboard.holdings,
    lots: store.lots.map(({ id, symbol, count, basisPerShare, purchaseDate, account }) => ({
      id,
      symbol,
      count,
      basisPerShare,
      purchaseDate,
      ...(account !== undefined ? { account } : {}),
    })),
    stops: store.stops.map(({ id, symbol, count, stopPrice }) => ({ id, symbol, count, stopPrice })),
    stories: dashboard.stories,
  };
}

export function sealVault(contents: VaultContents, token: string, iv: Buffer = randomBytes(12)): VaultDocument {
  const cipher = createCipheriv("aes-256-gcm", vaultKey(token), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(contents), "utf8"), cipher.final(), cipher.getAuthTag()]);
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
