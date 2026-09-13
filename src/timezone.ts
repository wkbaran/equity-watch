/**
 * Time-zone arithmetic without a date library.
 *
 * Three zones matter in this project, and they are never interchangeable:
 *
 *   - America/New_York (MARKET_TIME_ZONE): the exchange. Sessions, trading
 *     days, and bar boundaries are defined in it. Market logic must use it
 *     explicitly, never the machine's zone.
 *   - America/Denver: the zone the user's TradingView account displays and
 *     exports in (TRADINGVIEW_EXPORT_TIME_ZONE in src/alerts/seed.ts).
 *   - The machine's own zone: only for things a person reads or types
 *     locally - report file names, terminal output, "today" as a default.
 *
 * Instants (Date, ISO strings ending in Z) are zone-free; zones only enter
 * when converting to or from a wall clock.
 */

export const MARKET_TIME_ZONE = "America/New_York";

export interface WallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** What a clock in `timeZone` reads at `date`. */
export function wallClock(date: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some ICU builds render midnight as 24 even with h23.
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second
  );
}

/** Zone offset at `instant`, in ms: wall clock minus UTC. */
function offsetMs(instant: number, timeZone: string): number {
  const w = wallClock(new Date(instant), timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The instant at which a clock in `timeZone` reads the given wall time.
 * DST-aware. A wall time repeated when clocks fall back resolves to its first
 * occurrence; one skipped when clocks spring forward resolves to the instant
 * an hour later (the clock reads an hour ahead of what was asked).
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const wanted: WallClock = { year, month, day, hour, minute, second };
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two guesses: shift by the offset at the naive instant, then by the offset
  // at that result. Away from a DST change they agree. Across one, either or
  // both may read the wanted wall time.
  const first = asUtc - offsetMs(asUtc, timeZone);
  const refined = asUtc - offsetMs(first, timeZone);
  const matching = [first, refined].filter((t) => sameWallClock(wallClock(new Date(t), timeZone), wanted));
  // Both match on a repeated fall-back hour: take the earlier occurrence.
  // Neither matches in a skipped spring-forward hour: `first` reads an hour later.
  return new Date(matching.length > 0 ? Math.min(...matching) : first);
}

/** Minutes since midnight on the exchange's clock. */
export function marketMinuteOfDay(date: Date): number {
  const w = wallClock(date, MARKET_TIME_ZONE);
  return w.hour * 60 + w.minute;
}

/**
 * Midnight on the exchange's clock at the start of the calendar day after
 * `date`'s. Where a "today" window must end - not UTC midnight, which falls
 * during after-hours trading (19:00 or 20:00 Eastern, depending on DST).
 */
export function nextMarketMidnight(date: Date): Date {
  const w = wallClock(date, MARKET_TIME_ZONE);
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, MARKET_TIME_ZONE);
}

/** YYYY-MM-DD on the machine's own calendar, for defaults a person means as "today". */
export function localDateString(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
