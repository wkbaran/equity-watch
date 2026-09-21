/**
 * Remembers that Schwab's refresh token expired, so something other than the
 * command that hit the wall can say so.
 *
 * Schwab refresh tokens live 7 days and there is no way to renew one without
 * the browser flow, so this happens roughly weekly. The command that discovers
 * it is whichever ran first (usually `ops pull`), but the thing that needs to
 * report it is the dashboard publish at the end of the run - a different
 * process. A file is how they talk.
 *
 * It sits next to the token file rather than inside it: that file holds bearer
 * credentials and is written only on a *successful* token exchange. Marking a
 * failure there would mean rewriting secrets on a path that has nothing to say
 * about them.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AuthState {
  /**
   * When a refresh was first refused for an expired/revoked refresh token, or
   * null when the login is healthy. First, not latest: every run after the
   * expiry hits the same wall, and "expired since 01:55" is the useful fact.
   * Holding it steady also keeps it out of the publish fingerprint's way - a
   * timestamp that moved every run would publish every run.
   */
  expiredSince: string | null;
}

export const HEALTHY: AuthState = { expiredSince: null };

export function authStatePath(tokenPath: string): string {
  return join(dirname(tokenPath), "schwab_auth_state.json");
}

export function readAuthState(tokenPath: string): AuthState {
  const path = authStatePath(tokenPath);
  if (!existsSync(path)) {
    return HEALTHY;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AuthState>;
    return { expiredSince: typeof parsed.expiredSince === "string" ? parsed.expiredSince : null };
  } catch {
    // A corrupt marker must not take down a check. Healthy is the safe read:
    // the next refresh failure rewrites it, and a false "expired" banner on the
    // dashboard is worse than a late one.
    return HEALTHY;
  }
}

/**
 * Records the expiry, keeping the timestamp of the first failure. Returns the
 * state as it now stands so a caller can report the original time.
 */
export function markAuthExpired(tokenPath: string, when: string): AuthState {
  const existing = readAuthState(tokenPath);
  if (existing.expiredSince !== null) {
    return existing;
  }
  const state: AuthState = { expiredSince: when };
  const path = authStatePath(tokenPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}

/** Called on every successful token exchange, so recovery needs no extra step. */
export function clearAuthExpired(tokenPath: string): void {
  rmSync(authStatePath(tokenPath), { force: true });
}
