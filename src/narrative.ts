/**
 * Plain-English explanations of what happened, for a glanceable display.
 *
 * Two levels:
 *   - `triggerHeadline` - one line per trigger ("TGT broke resistance with
 *     volume", "Holding MKS broke support"), which is what a small always-on
 *     dashboard shows instead of a row of numbers.
 *   - `tickerStory` - the chronological thread for one ticker across repeated
 *     triggers and the re-levels between them, so a name you've been chasing
 *     up reads as one narrative rather than five disconnected events.
 *
 * Deliberately template-based, not model-generated. These lines describe
 * money decisions and get rendered unattended on a device with no way to
 * check them, so they must be reproducible, free, instant, and incapable of
 * inventing a fact that isn't in the verdict. Everything stated here is read
 * directly off a RevisitEntry's recorded signals.
 *
 * Written for e-ink: short lines, no colour, no emoji, no box-drawing, and
 * nothing that depends on a monospace grid to parse.
 */

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

/**
 * Whether the entry describes price moving up through its level or down
 * through it. Read off the trigger rather than the alert's stored side, so a
 * re-levelled alert can't retroactively change what a past event said.
 */
function direction(entry: RevisitEntry): "up" | "down" | null {
  if (entry.levelAtTrigger === null) {
    return null;
  }
  return entry.triggerPrice >= entry.levelAtTrigger ? "up" : "down";
}

/**
 * The core phrase: what the price actually did, qualified by how well it was
 * confirmed. "Broke resistance" is a stronger claim than "tagged" and is only
 * used where the verdict supports it.
 */
function movePhrase(entry: RevisitEntry): string {
  const dir = direction(entry);
  const verdict = entry.signals?.verdict ?? null;
  const volumeConfirmed = (entry.signals?.volumeScore ?? 0) >= 0.5;

  if (dir === "down") {
    return verdict === "CONFIRMED_BREAKOUT" || verdict === "WATCH" ? "broke support" : "slipped below support";
  }

  switch (verdict) {
    case "CONFIRMED_BREAKOUT":
      return volumeConfirmed ? "broke resistance with volume" : "broke resistance and held";
    case "WATCH":
      return "broke resistance on volume but failed to hold";
    case "WATCH_WEAK":
      return volumeConfirmed ? "pushed through on volume, but not at a real high" : "cleared its level on thin volume";
    case "NO_CLOSE_CONFIRM":
      return "tagged its level intraday but closed back below";
    case "NO":
      return "crossed its level with nothing confirming it";
    default:
      return volumeConfirmed ? "crossed its level on rising volume" : "crossed its level";
  }
}

/** One line describing a single trigger. */
export function triggerHeadline(entry: RevisitEntry, ctx: NarrativeContext): string {
  const held = ctx.heldSymbols.has(entry.symbol.toUpperCase());
  const subject = held ? `Holding ${entry.symbol}` : entry.symbol;

  if (entry.kind === "volume") {
    return `${subject} traded unusual volume`;
  }

  const session = entry.session ?? null;
  const sessionSuffix = session !== null && session !== "regular" ? `, in ${describeSession(session)}` : "";

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
    return `${subject} ${phrase}${sessionSuffix}`;
  }

  const parts = [`${subject} ${movePhrase(entry)}`];

  const move = entry.signals?.pctMovePastLevel ?? null;
  if (move !== null && Math.abs(move) >= 1) {
    parts.push(move >= 0 ? `now ${pct(move)} above it` : `now ${pct(move)} below it`);
  }

  return parts.join(", ") + sessionSuffix;
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
 */
export function tickerStory(symbol: string, entriesInput: RevisitEntry[], ctx: NarrativeContext): TickerStory {
  const entries = [...entriesInput].sort((a, b) => a.triggeredAt.localeCompare(b.triggeredAt));
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

  for (const entry of entries) {
    lines.push({ at: entry.triggeredAt, text: `${shortDate(entry.triggeredAt)}: ${triggerHeadline(entry, ctx)}.` });
    if (entry.status === "applied" && entry.appliedFrom != null && entry.appliedTo != null) {
      lines.push({
        at: entry.resolvedAt ?? entry.triggeredAt,
        text: `${shortDate(entry.resolvedAt ?? entry.triggeredAt)}: you raised the level ${entry.appliedFrom} to ${entry.appliedTo}.`,
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
  const first = entries[0];
  const last = entries[entries.length - 1];

  let summary: string;
  if (triggers === 0) {
    summary = `${symbol}: nothing on record.`;
  } else if (triggers === 1) {
    summary = `${symbol} fired once, ${shortDate(first.triggeredAt)}${open > 0 ? ", still waiting on you" : ""}.`;
  } else {
    const climbed =
      first.levelAtTrigger !== null && last.levelAtTrigger !== null && last.levelAtTrigger > first.levelAtTrigger;
    const held = `${symbol} has fired ${triggers} times since ${shortDate(first.triggeredAt)}`;
    const chase = climbed
      ? `, walking its level from ${first.levelAtTrigger} up to ${last.levelAtTrigger}`
      : applied > 0
        ? `, re-levelled ${applied} time${applied === 1 ? "" : "s"}`
        : "";
    summary = `${held}${chase}${open > 0 ? `, with ${open} still open` : ""}.`;
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
