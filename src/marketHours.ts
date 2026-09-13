/**
 * Market session hours, so polling only happens when there's data to poll.
 *
 * Taken from Schwab's `/marketdata/v1/markets` rather than hardcoded, because
 * the real calendar has holidays and half days: the day after Thanksgiving
 * 2026 has a regular session ending 13:00 ET and a post-market ending 17:00,
 * and a hardcoded 09:30-16:00 would poll a closed market for three hours and
 * miss the shortened post-market entirely.
 *
 * Sessions are kept distinct rather than collapsed into one "is it open"
 * boolean: a trigger during pre/post market is a thinner, wider-spread,
 * less-reliable signal than the same trigger at midday, so the session it
 * fired in is recorded on the trigger and surfaced in the report.
 */

export type Session = "pre" | "regular" | "post" | "closed";

export interface SessionWindow {
  start: Date;
  end: Date;
}

export interface MarketHours {
  /** Calendar date these hours describe, YYYY-MM-DD in market-local terms. */
  date: string;
  isOpen: boolean;
  preMarket: SessionWindow[];
  regularMarket: SessionWindow[];
  postMarket: SessionWindow[];
}

/** Sessions considered live for polling, loosest first. */
export const EXTENDED_SESSIONS: Session[] = ["pre", "regular", "post"];
export const REGULAR_SESSIONS: Session[] = ["regular"];

interface RawWindow {
  start?: string;
  end?: string;
}

interface RawProduct {
  date?: string;
  isOpen?: boolean;
  sessionHours?: {
    preMarket?: RawWindow[];
    regularMarket?: RawWindow[];
    postMarket?: RawWindow[];
  };
}

function toWindows(raw: RawWindow[] | undefined): SessionWindow[] {
  if (!raw) {
    return [];
  }
  const windows: SessionWindow[] = [];
  for (const w of raw) {
    if (!w.start || !w.end) {
      continue;
    }
    const start = new Date(w.start);
    const end = new Date(w.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      continue;
    }
    windows.push({ start, end });
  }
  return windows;
}

/**
 * Schwab keys the product differently depending on whether the market is
 * open: `equity.EQ` on a trading day, `equity.equity` on a closed one. Read
 * whatever single product is present rather than either literal.
 */
export function parseMarketHours(payload: unknown, fallbackDate: string): MarketHours {
  const closed: MarketHours = {
    date: fallbackDate,
    isOpen: false,
    preMarket: [],
    regularMarket: [],
    postMarket: [],
  };
  if (typeof payload !== "object" || payload === null) {
    return closed;
  }
  const equity = (payload as Record<string, unknown>)["equity"];
  if (typeof equity !== "object" || equity === null) {
    return closed;
  }
  const products = Object.values(equity as Record<string, RawProduct>);
  if (products.length === 0) {
    return closed;
  }
  const product = products[0];
  return {
    date: product.date ?? fallbackDate,
    isOpen: product.isOpen === true,
    preMarket: toWindows(product.sessionHours?.preMarket),
    regularMarket: toWindows(product.sessionHours?.regularMarket),
    postMarket: toWindows(product.sessionHours?.postMarket),
  };
}

/**
 * Rehydrates a MarketHours that was JSON-serialised to disk. Distinct from
 * parseMarketHours, which reads Schwab's raw wire format - the cache stores
 * the already-normalised shape, whose Dates came back as ISO strings.
 */
export function reviveMarketHours(raw: unknown): MarketHours | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== "string" || typeof r.isOpen !== "boolean") {
    return null;
  }
  const revive = (v: unknown): SessionWindow[] =>
    Array.isArray(v)
      ? v
          .map((w) => ({ start: new Date((w as RawWindow).start ?? ""), end: new Date((w as RawWindow).end ?? "") }))
          .filter((w) => !Number.isNaN(w.start.getTime()) && !Number.isNaN(w.end.getTime()))
      : [];
  return {
    date: r.date,
    isOpen: r.isOpen,
    preMarket: revive(r.preMarket),
    regularMarket: revive(r.regularMarket),
    postMarket: revive(r.postMarket),
  };
}

function within(windows: SessionWindow[], when: Date): boolean {
  const t = when.getTime();
  return windows.some((w) => t >= w.start.getTime() && t < w.end.getTime());
}

/**
 * Which session `when` falls in. Regular is checked first: Schwab reports the
 * pre-market ending exactly where the regular session starts (and regular
 * ending where post starts), so an instant on a boundary must resolve to the
 * more significant session rather than whichever is tested first.
 */
export function sessionAt(hours: MarketHours | null, when: Date): Session {
  if (hours === null || !hours.isOpen) {
    return "closed";
  }
  if (within(hours.regularMarket, when)) {
    return "regular";
  }
  if (within(hours.preMarket, when)) {
    return "pre";
  }
  if (within(hours.postMarket, when)) {
    return "post";
  }
  return "closed";
}

export function isPollable(session: Session, allowed: Session[]): boolean {
  return allowed.includes(session);
}

/** How long until the next session in `allowed` opens, or null if none remain today. */
export function msUntilNextSession(hours: MarketHours | null, when: Date, allowed: Session[]): number | null {
  if (hours === null || !hours.isOpen) {
    return null;
  }
  const candidates: number[] = [];
  const byName: Record<string, SessionWindow[]> = {
    pre: hours.preMarket,
    regular: hours.regularMarket,
    post: hours.postMarket,
  };
  for (const name of allowed) {
    for (const w of byName[name] ?? []) {
      if (w.start.getTime() > when.getTime()) {
        candidates.push(w.start.getTime());
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return Math.min(...candidates) - when.getTime();
}

export function describeSession(session: Session): string {
  switch (session) {
    case "pre":
      return "pre-market";
    case "regular":
      return "regular hours";
    case "post":
      return "after hours";
    default:
      return "market closed";
  }
}

/** The market-local calendar date to request hours for. Schwab's equity calendar is US/Eastern. */
export function marketDate(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}
