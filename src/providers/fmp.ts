/**
 * Financial Modeling Prep - used only for company sector/industry/
 * description, since Schwab's API doesn't expose this data at all (checked
 * live against both /marketdata/v1/quotes?fields=fundamental and
 * /marketdata/v1/instruments?projection=fundamental).
 *
 * Free tier: 250 requests/day. See src/profiles/budget.ts for the
 * cross-invocation daily budget tracker this requires.
 */

const PROFILE_URL = "https://financialmodelingprep.com/stable/profile";

// Financial Modeling Prep's free tier request cap, per calendar day.
export const FMP_FREE_DAILY_LIMIT = 250;

export interface CompanyProfile {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  description: string | null;
}

interface ProfileResponseItem {
  symbol: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  description?: string;
}

export class FmpProvider {
  constructor(private apiKey: string) {}

  async getProfile(symbol: string): Promise<CompanyProfile | null> {
    const params = new URLSearchParams({ symbol, apikey: this.apiKey });
    const response = await fetch(`${PROFILE_URL}?${params}`);
    if (!response.ok) {
      throw new Error(`FMP profile request for ${symbol} failed (${response.status}): ${await response.text()}`);
    }

    const payload = (await response.json()) as ProfileResponseItem[];
    const item = payload[0];
    if (!item) {
      return null;
    }
    return {
      symbol: item.symbol,
      companyName: item.companyName ?? null,
      sector: item.sector ?? null,
      industry: item.industry ?? null,
      description: item.description ?? null,
    };
  }
}
