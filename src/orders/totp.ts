/**
 * Authenticator codes (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30-second steps),
 * the second factor every order op carries (docs/WEBULL_SYNC_PLAN.md,
 * Security). The secret lives only on the machine that sends orders
 * (ORDERS_TOTP_SECRET); the browser never has it, so the ops token alone, even
 * stolen, queues no order.
 */

import { createHmac, randomBytes } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
/** Codes one step either side are accepted, for clock drift and a code typed as it rolled over. */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) {
      throw new Error("The TOTP secret isn't base32 (letters A-Z and digits 2-7).");
    }
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, base32: what an authenticator app is given. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

export function stepOf(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step a code belongs to, if it is valid now and wasn't used before.
 * `used` holds the steps already spent: a code is good once, so one read off a
 * screen or a log can't be replayed within its minute.
 */
export function verifyTotp(secret: string, code: string, now: Date, used: Set<number>): { ok: true; step: number } | { ok: false; reason: string } {
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, reason: "The authenticator code must be 6 digits." };
  }
  const current = stepOf(now);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const step = current + d;
    if (totpAt(secret, step) === code) {
      return used.has(step) ? { ok: false, reason: "That authenticator code was already used. Wait for the next one." } : { ok: true, step };
    }
  }
  return { ok: false, reason: "The authenticator code is wrong or expired." };
}

/** What an authenticator app reads (as a QR code, or typed): the account name and issuer show in the app. */
export function otpauthUri(secret: string, label = "equity-watch orders"): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=equity-watch&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}
