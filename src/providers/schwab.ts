/**
 * Schwab market-data provider.
 *
 * Schwab's individual developer API uses a standard OAuth2 authorization-code
 * flow with a short-lived (30 min) access token and a longer-lived (7 day)
 * refresh token. See SETUP.md for how to register an app and get an App Key
 * / App Secret.
 *
 * This talks directly to the REST API with `fetch` rather than pulling in a
 * third-party Schwab client, so the OAuth/token handling here is fully
 * visible and auditable. Endpoints and parameter names follow Schwab's
 * published `marketdata` API (a continuation of the old TD Ameritrade API
 * shape); double-check against https://developer.schwab.com if Schwab has
 * changed anything since.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import open from "open";
import type { PriceBar } from "../models.js";
import { RateLimiter } from "./rateLimiter.js";
import type { PriceDataProvider } from "./types.js";

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const PRICE_HISTORY_URL = "https://api.schwabapi.com/marketdata/v1/pricehistory";
const QUOTES_URL = "https://api.schwabapi.com/marketdata/v1/quotes";

// Refresh a bit before the access token actually expires to avoid racing a
// request against expiry.
const ACCESS_TOKEN_SAFETY_MARGIN_SECONDS = 60;

export class SchwabAuthError extends Error {}

interface TokenState {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number; // unix epoch seconds
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function tokenStateFromResponse(payload: TokenResponse, obtainedAt: number): TokenState {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessTokenExpiresAt: obtainedAt + payload.expires_in,
  };
}

export class SchwabAuth {
  private appKey: string;
  private appSecret: string;
  private tokenPath: string;
  private callbackUrl: string;
  private state: TokenState | null;

  constructor(appKey: string, appSecret: string, tokenPath: string, callbackUrl = "https://127.0.0.1") {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.tokenPath = tokenPath;
    this.callbackUrl = callbackUrl;
    this.state = this.loadTokenState();
  }

  private loadTokenState(): TokenState | null {
    if (!existsSync(this.tokenPath)) {
      return null;
    }
    return JSON.parse(readFileSync(this.tokenPath, "utf-8")) as TokenState;
  }

  private saveTokenState(): void {
    if (!this.state) {
      return;
    }
    mkdirSync(dirname(this.tokenPath), { recursive: true });
    writeFileSync(this.tokenPath, JSON.stringify(this.state, null, 2));
    // Token file contains bearer credentials; keep it user-readable only.
    chmodSync(this.tokenPath, 0o600);
  }

  private basicAuthHeader(): string {
    return "Basic " + Buffer.from(`${this.appKey}:${this.appSecret}`).toString("base64");
  }

  /**
   * Run the one-time browser login flow and persist the resulting tokens.
   *
   * Only needs to be run once per refresh-token lifetime (Schwab refresh
   * tokens are valid for 7 days; re-run this whenever getAccessToken() starts
   * throwing SchwabAuthError because the refresh token expired).
   */
  async authorizeInteractive(): Promise<void> {
    const authUrl = `${AUTHORIZE_URL}?client_id=${this.appKey}&redirect_uri=${this.callbackUrl}`;
    console.log("Opening Schwab login in your browser. If it doesn't open, visit:");
    console.log(authUrl);
    await open(authUrl);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const redirectedUrl = (
      await rl.question("\nAfter approving access, paste the full URL you were redirected to: ")
    ).trim();
    rl.close();

    const code = new URL(redirectedUrl).searchParams.get("code");
    if (!code) {
      throw new SchwabAuthError("Could not find an authorization `code` in the pasted URL.");
    }

    const obtainedAt = Date.now() / 1000;
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.callbackUrl,
      }),
    });
    if (!response.ok) {
      throw new SchwabAuthError(`Token exchange failed (${response.status}): ${await response.text()}`);
    }

    this.state = tokenStateFromResponse((await response.json()) as TokenResponse, obtainedAt);
    this.saveTokenState();
  }

  private async refresh(): Promise<void> {
    if (!this.state) {
      throw new SchwabAuthError(
        "No cached Schwab tokens found. Run authorizeInteractive() first " +
          "(e.g. `tv-alerts schwab-login`)."
      );
    }

    const obtainedAt = Date.now() / 1000;
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.state.refreshToken,
      }),
    });
    if (!response.ok) {
      throw new SchwabAuthError(
        `Token refresh failed (${response.status}): ${await response.text()}. ` +
          "The refresh token may have expired (7 day lifetime) - re-run authorizeInteractive()."
      );
    }

    this.state = tokenStateFromResponse((await response.json()) as TokenResponse, obtainedAt);
    this.saveTokenState();
  }

  async getAccessToken(): Promise<string> {
    if (!this.state) {
      throw new SchwabAuthError(
        "No cached Schwab tokens found. Run authorizeInteractive() first " + "(e.g. `tv-alerts schwab-login`)."
      );
    }
    if (Date.now() / 1000 >= this.state.accessTokenExpiresAt - ACCESS_TOKEN_SAFETY_MARGIN_SECONDS) {
      await this.refresh();
    }
    return this.state!.accessToken;
  }
}

interface Candle {
  datetime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PriceHistoryResponse {
  candles: Candle[];
}

interface QuoteResponse {
  [symbol: string]: { quote?: { lastPrice: number } };
}

// Schwab's Market Data API is limited to 120 calls/minute per app.
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 120;

export class SchwabProvider implements PriceDataProvider {
  private rateLimiter: RateLimiter;

  constructor(
    private auth: SchwabAuth,
    maxRequestsPerMinute: number = DEFAULT_MAX_REQUESTS_PER_MINUTE
  ) {
    this.rateLimiter = new RateLimiter(maxRequestsPerMinute, 60_000);
  }

  async getDailyBars(symbol: string, start: Date, end: Date): Promise<PriceBar[]> {
    const params = new URLSearchParams({
      symbol,
      periodType: "year",
      frequencyType: "daily",
      frequency: "1",
      startDate: String(start.getTime()),
      endDate: String(end.getTime()),
      needExtendedHoursData: "false",
    });

    await this.rateLimiter.acquire();
    const accessToken = await this.auth.getAccessToken();
    const response = await fetch(`${PRICE_HISTORY_URL}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `Schwab price history request for ${symbol} failed (${response.status}): ${await response.text()}`
      );
    }

    const payload = (await response.json()) as PriceHistoryResponse;
    return (payload.candles ?? []).map((candle) => ({
      date: new Date(candle.datetime),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  }

  /** Current last-traded price per symbol, for periodic alert checks. */
  async getQuotes(symbols: string[]): Promise<Map<string, number>> {
    if (symbols.length === 0) {
      return new Map();
    }

    await this.rateLimiter.acquire();
    const accessToken = await this.auth.getAccessToken();
    const params = new URLSearchParams({ symbols: symbols.join(",") });
    const response = await fetch(`${QUOTES_URL}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Schwab quotes request failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as QuoteResponse;
    const result = new Map<string, number>();
    for (const [symbol, data] of Object.entries(payload)) {
      if (data.quote?.lastPrice !== undefined) {
        result.set(symbol, data.quote.lastPrice);
      }
    }
    return result;
  }
}
