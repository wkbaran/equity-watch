/**
 * Plain-English explanations of what happened, for a glanceable display.
 *
 * Two levels:
 *   - `triggerHeadline` - one line per trigger ("TGT crossed above 50 on
 *     volume", "Holding MKS crossed below 110, then climbed back above
 *     it the same day"), which is what a small always-on dashboard shows
 *     instead of a row of numbers.
 *   - `tickerStory` - the chronological thread for one ticker across repeated
 *     triggers and the re-levels between them, so a name you've been chasing
 *     up reads as one narrative rather than five disconnected events.
 *
 * Deliberately template-based, not model-generated. These lines describe
 * money decisions and get rendered unattended on a device with no way to
 * check them, so they must be reproducible, free, instant, and incapable of
 * inventing a fact that isn't in the verdict. Everything stated here is read
 * directly off a RevisitEntry's recorded signals and follow-ups.
 *
 * No "support" or "resistance": those name levels the market has tested
 * repeatedly, and an alert level is just a number someone picked. Every line
 * says what price did relative to the alert's level, and names the level.
 *
 * Written for e-ink: short lines, no colour, no emoji, no box-drawing, and
 * nothing that depends on a monospace grid to parse.
 */

import type { CrossDirection } from "./alerts/models.js";
import { endedOnFiredSide, entryDirection, reversalOf, tradingDaysAfter } from "./alerts/reversion.js";
import type { RevisitEntry } from "./alerts/revisit.js";
import { maLabel } from "./indicators/movingAverage.js";
import { describeSession, type Session } from "./marketHours.js";

export interface NarrativeContext {
  /** Symbols currently held, so a trigger on a position reads differently. */
  heldSymbols: Set<string>;
}

function pct(n: number): string {
  return `${Math.abs(n) < 10 ? Math.abs(n).toFixed(1) : Math.round(Math.abs(n))}%`;
}

/** "above" for an upward crossing, "below" for a downward one. */
function sideOf(dir: CrossDirection): string {
  return dir === "up" ? "above" : "below";
}

function otherSide(dir: CrossDirection): string {
  return dir === "up" ? "below" : "above";
}

/** Trading days after the fire, as words: "the same day", "the next day", "2 days later". */
export function dayPhrase(days: number): string {
  return days === 0 ? "the same day" : days === 1 ? "the next day" : `${days} days later`;
}

/**
 * The core phrase: what the price did against the level, qualified by how well
 * the verdict confirmed it. Claims about holding are only made where the
 * verdict supports them, and NO_CLOSE_CONFIRM never reads as a completed move.
 *
 * With a recorded reversal, hold claims are left to the reversal clause, which
 * says exactly when price went back rather than restating it vaguely.
 */
function movePhrase(entry: RevisitEntry, dir: CrossDirection | null, reversed: boolean): string {
  const verdict = entry.signals?.verdict ?? null;
  const volumeConfirmed = (entry.signals?.volumeScore ?? 0) >= 0.5;
  // A trailing alert's stored level is where it started, not what it fired at.
  const trailing = entry.kind === "trailing";
  const base = trailing
    ? `hit its trailing trigger at ${entry.triggerPrice}`
    : dir === null || entry.levelAtTrigger === null
      ? "crossed its level"
      : `crossed ${sideOf(dir)} ${entry.levelAtTrigger}`;
  const extreme = dir === "down" ? "low" : "high";
  const closedPast = trailing || dir === null ? "closed past it" : `closed ${sideOf(dir)} it`;

  // Both verdicts guarantee a close past the level on confirmed volume, and
  // nothing more about holding: CONFIRMED_BREAKOUT includes "too soon to tell",
  // and WATCH means volume faded *or* it failed to hold, without recording which.
  switch (verdict) {
    case "CONFIRMED_BREAKOUT":
      return `${base} and ${closedPast} on volume`;
    case "WATCH":
      return `${base} and ${closedPast} on volume${reversed ? "" : ", but volume faded or it didn't hold"}`;
    case "WATCH_WEAK":
      return volumeConfirmed ? `${base} on volume, well short of its recent ${extreme}` : `${base} on thin volume`;
    case "NO_CLOSE_CONFIRM":
      return trailing || dir === null
        ? `${base} intraday but didn't close past it`
        : `${base} intraday but closed back ${otherSide(dir)}`;
    case "NO":
      return `${base} with nothing confirming it`;
    default:
      return volumeConfirmed ? `${base} on rising volume` : base;
  }
}

/** A follow-up count at or above this reads as a count rather than a sequence. */
const MANY_CROSSINGS = 3;

/**
 * What price did at the level after the fire: when it went back, and whether
 * it returned. Null when nothing reversed it.
 */
function reversalClause(entry: RevisitEntry, dir: CrossDirection | null): string | null {
  const reversal = reversalOf(entry);
  if (reversal === null || dir === null) {
    return null;
  }
  const firedAt = new Date(entry.triggeredAt);
  const followUps = entry.followUps ?? [];
  const reversalDays = tradingDaysAfter(firedAt, new Date(reversal.at));
  const wentBack = `${dir === "up" ? "fell" : "climbed"} back ${otherSide(dir)} it`;
  // NO_CLOSE_CONFIRM already says it closed back past the level that day.
  const implied = entry.signals?.verdict === "NO_CLOSE_CONFIRM" && reversalDays === 0;

  if (followUps.length >= MANY_CROSSINGS) {
    const ending = `ending ${endedOnFiredSide(entry) ? sideOf(dir) : otherSide(dir)} it`;
    return implied
      ? `then crossed it ${followUps.length - 1} more times, ${ending}`
      : `then ${wentBack} ${dayPhrase(reversalDays)}, crossing it ${followUps.length} times in all, ${ending}`;
  }

  const after = followUps.slice(followUps.indexOf(reversal) + 1);
  const returned = after.find((f) => f.direction === dir);
  const cameBack =
    returned === undefined
      ? null
      : `${dir === "up" ? "climbed" : "fell"} back ${sideOf(dir)} it ${dayPhrase(tradingDaysAfter(firedAt, new Date(returned.at)))}`;

  if (implied) {
    return cameBack === null ? null : `then ${cameBack}`;
  }
  return `then ${wentBack} ${dayPhrase(reversalDays)}${cameBack === null ? "" : ` and ${cameBack}`}`;
}

/** One line describing a single trigger. */
export function triggerHeadline(entry: RevisitEntry, ctx: NarrativeContext): string {
  const held = ctx.heldSymbols.has(entry.symbol.toUpperCase());
  const subject = held ? `Holding ${entry.symbol}` : entry.symbol;

  if (entry.kind === "volume") {
    return `${subject} traded unusual volume`;
  }

  const session = entry.session ?? null;
  const sessionSuffix = session !== null && session !== "regular" ? `in ${describeSession(session)}` : null;

  // Moving-average triggers say exactly what was recorded - which average and
  // whether price crossed or touched it - and nothing about breakout quality,
  // which was never judged for them.
  if (entry.ma !== undefined) {
    const label = maLabel(entry.ma);
    const from = entry.ma.approachedFrom === null ? "" : ` from ${entry.ma.approachedFrom}`;
    const phrase =
      entry.ma.event === "touch"
        ? `touched its ${label}${from}`
        : entry.ma.event === "cross_up"
          ? `crossed above its ${label}`
          : `crossed below its ${label}`;
    return `${subject} ${phrase}${sessionSuffix === null ? "" : `, ${sessionSuffix}`}`;
  }

  const dir = entryDirection(entry);
  const reversal = reversalClause(entry, dir);
  const parts = [`${subject} ${movePhrase(entry, dir, reversalOf(entry) !== null)}`];
  // The session belongs to the fire, so it sits next to it rather than after
  // a reversal that may have happened on another day.
  if (sessionSuffix !== null) {
    parts.push(sessionSuffix);
  }
  if (reversal !== null) {
    parts.push(reversal);
  }

  const move = entry.signals?.pctMovePastLevel ?? null;
  if (move !== null && Math.abs(move) >= 1) {
    parts.push(move >= 0 ? `now ${pct(move)} above it` : `now ${pct(move)} below it`);
  }

  return parts.join(", ");
}

/** A watch this long with this little movement is worth mentioning as dead weight. */
const QUIET_AFTER_DAYS = 45;
const QUIET_WITHIN_PCT = 5;

function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" });
}

function fullDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    timeZone: "America/New_York",
  });
}

function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
}

/**
 * How the name has done since you started watching it, as opposed to since it
 * fired. Answers "was this worth watching at all", which the trigger itself
 * can't say.
 */
export function sinceWatchingNote(
  watchingSince: string | null,
  priceAtWatchStart: number | null,
  currentPrice: number | null,
  approximate: boolean
): string | null {
  if (watchingSince === null) {
    return null;
  }
  // An imported alert's start date is a lower bound, so it reads as "or
  // earlier" rather than asserting a date the export never carried.
  const when = approximate ? `${monthYear(watchingSince)} or earlier` : monthYear(watchingSince);
  if (priceAtWatchStart === null || currentPrice === null || priceAtWatchStart <= 0) {
    return `Watching since ${when}.`;
  }
  const move = ((currentPrice - priceAtWatchStart) / priceAtWatchStart) * 100;
  if (Math.abs(move) < 1) {
    return `Flat since you started watching it, ${when}.`;
  }
  return `${move >= 0 ? "Up" : "Down"} ${pct(move)} since you started watching it, ${when}.`;
}

/**
 * The other half of the same question: a name being watched a long time that
 * has never fired and has barely moved is a slot you could spend elsewhere.
 * Returns null unless it genuinely qualifies, so it stays a signal.
 */
export function quietWatchNote(
  opts: {
    symbol: string;
    /** When you first became interested - may predate this system entirely. */
    watchingSince: string;
    watchingSinceApprox: boolean;
    /** When THIS system started watching. Dormancy is measured from here. */
    observedSince: string;
    priceAtWatchStart: number | null;
    currentPrice: number | null;
    triggerCount: number;
  },
  now: Date
): string | null {
  if (opts.triggerCount > 0) {
    return null;
  }
  // Dormancy is measured from when this system started watching, not from the
  // backdated interest date. An imported alert's watchingSince is the date it
  // last fired *in TradingView*, so measuring from there would let us announce
  // that a name has "never fired" on the strength of the very trigger that
  // supplied the date.
  const days = daysSince(opts.observedSince, now);
  if (days < QUIET_AFTER_DAYS) {
    return null;
  }
  const started = `${opts.watchingSinceApprox ? "at least since " : ""}${fullDate(opts.watchingSince)}`;
  const quiet = `nothing in ${days}d`;
  if (opts.priceAtWatchStart === null || opts.currentPrice === null || opts.priceAtWatchStart <= 0) {
    return `${opts.symbol}: watching ${started}, ${quiet}.`;
  }
  const move = ((opts.currentPrice - opts.priceAtWatchStart) / opts.priceAtWatchStart) * 100;
  if (Math.abs(move) > QUIET_WITHIN_PCT) {
    // It moved; it just hasn't crossed the level. That's a working alert, not a quiet one.
    return null;
  }
  return `${opts.symbol}: watching ${started}, ${quiet}, ${move >= 0 ? "up" : "down"} only ${pct(move)} since.`;
}

/** The action the entry is waiting on, as a sentence rather than a field. */
export function triggerAction(entry: RevisitEntry): string | null {
  if (entry.status === "dismissed") {
    return null;
  }
  if (entry.suggestedLevel === null) {
    return entry.levelAtTrigger === null ? null : `Level ${entry.levelAtTrigger} still stands.`;
  }
  return `Suggest moving ${entry.levelAtTrigger} to ${entry.suggestedLevel}.`;
}

export interface StoryLine {
  at: string;
  text: string;
}

export interface TickerStory {
  symbol: string;
  held: boolean;
  /** Chronological beats: triggers and the re-levels between them. */
  lines: StoryLine[];
  /** One-sentence summary of the whole thread. */
  summary: string;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

/**
 * Threads one ticker's entries into a story. The interesting shape this
 * exposes is the chase: fired, re-levelled higher, fired again. That pattern
 * is invisible in a flat list of triggers but is the whole reason the revisit
 * queue exists.
 *
 * Legacy follow-up entries (`followUpOf`) are skipped: their crossing is
 * already told as part of the fire they follow.
 */
export function tickerStory(symbol: string, entriesInput: RevisitEntry[], ctx: NarrativeContext): TickerStory {
  const entries = entriesInput
    .filter((e) => e.followUpOf === undefined)
    .sort((a, b) => a.triggeredAt.localeCompare(b.triggeredAt));
  const held = ctx.heldSymbols.has(symbol.toUpperCase());
  const lines: StoryLine[] = [];

  // Open on when this name entered the picture, so the thread reads as a
  // history rather than starting mid-stream at the first trigger.
  const origin = entries.find((e) => e.watchingSince !== null);
  if (origin?.watchingSince != null && origin.watchingSince < entries[0].triggeredAt) {
    lines.push({
      at: origin.watchingSince,
      text: `${shortDate(origin.watchingSince)}: you started watching ${symbol}${
        origin.watchingSinceApprox ? " (or earlier)" : ""
      }.`,
    });
  }

  // One edit closes every open entry for its alert (closeRevisitsForEdit), so
  // several entries can carry the same move. It happened once; say it once.
  const movesTold = new Set<string>();
  for (const entry of entries) {
    lines.push({ at: entry.triggeredAt, text: `${shortDate(entry.triggeredAt)}: ${triggerHeadline(entry, ctx)}.` });
    if (entry.status === "applied" && entry.appliedFrom != null && entry.appliedTo != null) {
      const key = `${entry.alertId}|${entry.resolvedAt}|${entry.appliedFrom}|${entry.appliedTo}`;
      if (movesTold.has(key)) continue;
      movesTold.add(key);
      lines.push({
        at: entry.resolvedAt ?? entry.triggeredAt,
        text: `${shortDate(entry.resolvedAt ?? entry.triggeredAt)}: you ${entry.appliedTo > entry.appliedFrom ? "raised" : "lowered"} the level ${entry.appliedFrom} to ${entry.appliedTo}.`,
      });
    } else if (entry.status === "dismissed") {
      lines.push({
        at: entry.resolvedAt ?? entry.triggeredAt,
        text: `${shortDate(entry.resolvedAt ?? entry.triggeredAt)}: you left the level where it was.`,
      });
    }
  }

  const triggers = entries.length;
  const applied = entries.filter((e) => e.status === "applied").length;
  const open = entries.filter((e) => e.status === "open").length;
  const reversed = entries.filter((e) => reversalOf(e) !== null).length;
  const first = entries[0];
  const last = entries[entries.length - 1];

  let summary: string;
  if (triggers === 0) {
    summary = `${symbol}: nothing on record.`;
  } else if (triggers === 1) {
    summary = `${symbol} fired once, ${shortDate(first.triggeredAt)}${reversed > 0 ? ", then reversed" : ""}${
      open > 0 ? ", still waiting on you" : ""
    }.`;
  } else {
    const climbed =
      first.levelAtTrigger !== null && last.levelAtTrigger !== null && last.levelAtTrigger > first.levelAtTrigger;
    const fired = `${symbol} has fired ${triggers} times since ${shortDate(first.triggeredAt)}`;
    const chase = climbed
      ? `, walking its level from ${first.levelAtTrigger} up to ${last.levelAtTrigger}`
      : applied > 0
        ? `, re-levelled ${applied} time${applied === 1 ? "" : "s"}`
        : "";
    const reversals = reversed > 0 ? `, ${reversed} of them reversed` : "";
    summary = `${fired}${chase}${reversals}${open > 0 ? `, with ${open} still open` : ""}.`;
  }

  return { symbol, held, lines, summary };
}

/** The stories worth telling: tickers with the most going on, most active first. */
export function buildStories(
  entries: RevisitEntry[],
  ctx: NarrativeContext,
  opts: { limit?: number; minTriggers?: number } = {}
): TickerStory[] {
  const minTriggers = opts.minTriggers ?? 2;
  const bySymbol = new Map<string, RevisitEntry[]>();
  for (const e of entries) {
    // A legacy follow-up is part of another fire, not a trigger of its own.
    if (e.followUpOf !== undefined) {
      continue;
    }
    bySymbol.set(e.symbol, [...(bySymbol.get(e.symbol) ?? []), e]);
  }

  const stories: TickerStory[] = [];
  for (const [symbol, symbolEntries] of bySymbol) {
    if (symbolEntries.length < minTriggers) {
      continue;
    }
    stories.push(tickerStory(symbol, symbolEntries, ctx));
  }

  stories.sort((a, b) => {
    // Positions first, then the busiest threads.
    if (a.held !== b.held) {
      return a.held ? -1 : 1;
    }
    return b.lines.length - a.lines.length;
  });
  return opts.limit ? stories.slice(0, opts.limit) : stories;
}

export type { Session };
