import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authStatePath, clearAuthExpired, markAuthExpired, readAuthState } from "../src/providers/authState.js";
import { isExpiredRefreshToken } from "../src/providers/schwab.js";

/** The real body Schwab returned on 2026-09-19 when the refresh token died. */
const EXPIRED_BODY =
  '{"error":"unsupported_token_type","error_description":"400 Bad Request: \\"{\\"error_description\\":\\"Refresh token is invalid, expired or revoked\\",\\"error\\":\\"invalid_grant\\"}\\""}';

describe("isExpiredRefreshToken", () => {
  it("recognizes the expiry Schwab actually sends", () => {
    // The outer envelope says `unsupported_token_type`, so anything reading the
    // top-level `error` field concludes the wrong thing. The fact is nested.
    expect(JSON.parse(EXPIRED_BODY).error).toBe("unsupported_token_type");
    expect(isExpiredRefreshToken(400, EXPIRED_BODY)).toBe(true);
  });

  it("leaves transient failures alone", () => {
    // A 500 or a gateway error must not send the user through a browser login,
    // and must not put a banner on the dashboard: the next run may well work.
    expect(isExpiredRefreshToken(500, "upstream unavailable")).toBe(false);
    expect(isExpiredRefreshToken(503, EXPIRED_BODY)).toBe(false);
    expect(isExpiredRefreshToken(400, '{"error":"invalid_request"}')).toBe(false);
  });
});

describe("auth state marker", () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "equity-watch-auth-"));
    tokenPath = join(dir, "schwab_tokens.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads healthy when nothing has failed", () => {
    expect(readAuthState(tokenPath).expiredSince).toBeNull();
  });

  it("keeps the first failure's time across later failures", () => {
    // Every run after the expiry hits the same wall. If each one restamped it,
    // the page would say "expired 0 min ago" forever - and, worse, the changing
    // timestamp would change the publish fingerprint and publish every run.
    markAuthExpired(tokenPath, "2026-09-19T08:00:00.000Z");
    markAuthExpired(tokenPath, "2026-09-19T08:15:00.000Z");
    expect(readAuthState(tokenPath).expiredSince).toBe("2026-09-19T08:00:00.000Z");
  });

  it("clears on a successful token exchange", () => {
    markAuthExpired(tokenPath, "2026-09-19T08:00:00.000Z");
    clearAuthExpired(tokenPath);
    expect(readAuthState(tokenPath).expiredSince).toBeNull();
  });

  it("is safe to clear when it was never set", () => {
    expect(() => clearAuthExpired(tokenPath)).not.toThrow();
  });

  it("reads healthy from a corrupt marker rather than throwing", () => {
    // A bad file must not take down a scheduled check, and a false "expired"
    // banner would be worse than a late one.
    writeFileSync(authStatePath(tokenPath), "{not json");
    expect(readAuthState(tokenPath).expiredSince).toBeNull();
  });

  it("sits beside the token file without touching it", () => {
    // The token file holds bearer credentials and is written only on a
    // successful exchange; a failure has no business rewriting it.
    writeFileSync(tokenPath, '{"accessToken":"secret"}');
    markAuthExpired(tokenPath, "2026-09-19T08:00:00.000Z");
    expect(readFileSync(tokenPath, "utf-8")).toBe('{"accessToken":"secret"}');
    expect(authStatePath(tokenPath)).toBe(join(dir, "schwab_auth_state.json"));
  });
});
