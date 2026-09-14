/**
 * The revisit queue: what replaces "the alert disarmed and I have to
 * remember to re-arm it somewhere else".
 *
 * Alerts never disarm (src/alerts/models.ts). Every trigger appends an entry
 * here instead - a durable to-do item saying "this level got taken out, the
 * level is probably stale now, decide what to do about it". The alert itself
 * stays live at its original level the whole time, so nothing stops being
 * watched while an entry sits in the queue.
 *
 * Entries carry a *suggested* new level, never an applied one. Re-leveling is
 * an explicit act (`alert revisit apply <id>`); the queue only ever proposes.
 *
 * Priority blends five signals, each normalized to 0..1 and then weighted.
 * The per-signal scores are stored alongside the total so a report can show
 * *why* something is near the top rather than just asserting a number.
 */

import { randomUUID } from "node:crypto";
import type { Session } from "../marketHours.js";
import type { MaTimeframe, MaType } from "../indicators/movingAverage.js";
import type { Alert, AlertSide, CrossDirection, MaEvent } from "./models.js";
import { describeAlertCondition } from "./describe.js";

/** What a volume condition measured at the moment it was satisfied. */
export interface RevisitVolume {
  /** Shares traded over the window. */
  observed: number;
  /** Shares the condition demanded, rounded to a whole share. */
  required: number;
  /** "today", or a trailing window such as "30m". */
  window: string;
  basis: "threshold" | "ratio";
}

export interface RevisitMa {
  maType: MaType;
  period: number;
  timeframe: MaTimeframe;
  event: MaEvent;
  approachedFrom: AlertSide | null;
}

export type RevisitStatus = "open" | "applied" | "dismissed";

export interface RevisitSignals {
  /** Breakout verdict from analysis.ts, once an analyze pass has run over this entry. */
  verdict: string | null;
  verdictScore: number;
  /**
   * Where price now sits against the level, in percent: (close - level) / level.
   * Raw, not direction-relative - negative is below the level whichever way
   * the alert fired. `moveDirection` says which sign is "past".
   */
  pctMovePastLevel: number | null;
  /**
   * Which way the entry fired, so the move can be read relative to it. Absent
   * on signals scored before 2026-09-14, which were all read as upward.
   */
  moveDirection?: CrossDirection;
  moveScore: number;
  /** Days this entry has sat open. */
  daysOpen: number;
  stalenessScore: number;
  /** Whether this symbol is in holdings.json. */
  heldPosition: boolean;
  positionScore: number;
  /**
   * Volume signals apply whether or not the alert itself had a volume
   * condition - rising volume is evidence about the move regardless of how
   * the alert was originally defined.
   */
  volumeRatio: number | null;
  volumeTrendRatio: number | null;
  volumeScore: number;
}

export interface RevisitEntry {
  id: string;
  alertId: string;
  symbol: string;
  kind: Alert["kind"];
  triggeredAt: string;
  triggerPrice: number;
  /** The alert's level at the moment it fired. Null for volume-only alerts. */
  levelAtTrigger: number | null;
  /**
   * Which market session it fired in. A pre/post-market trigger is thinner
   * and wider-spread than the same move at midday, so it is recorded rather
   * than flattened into "it fired". Null on entries written before sessions
   * were tracked.
   */
  session: Session | null;
  /** When this name started being watched, copied off the alert at trigger time. */
  watchingSince: string | null;
  watchingSinceApprox: boolean;
  /** Price when watching started, for "up X% since you started watching". */
  priceAtWatchStart: number | null;
  status: RevisitStatus;
  /** What an `apply` actually moved, so the story can say so afterwards. */
  appliedFrom: number | null;
  appliedTo: number | null;
  /** Proposed replacement level. Null until a relevel pass has run. */
  suggestedLevel: number | null;
  suggestedAt: string | null;
  suggestionBasis: string | null;
  resolvedAt: string | null;
  /** 0-100. Null until a scoring pass has run. */
  priority: number | null;
  signals: RevisitSignals | null;
  /**
   * Set on moving-average triggers: which average, and what price did against
   * it. `levelAtTrigger` holds the average's value at that moment. Optional so
   * entries written before moving averages existed stay valid.
   */
  ma?: RevisitMa;
  /**
   * The alert's condition in words as of the trigger. Absent on entries
   * written before this was recorded (2026-09-13); a reader can fall back to
   * the alert's current settings, but must say that's what it's showing.
   */
  condition?: string;
  /**
   * What the volume condition measured when it fired. Absent when the alert
   * had no volume condition, and on entries written before it was recorded.
   */
  volume?: RevisitVolume;
  /**
   * Which way price crossed the level when this fired. Absent on entries
   * written before 2026-09-14 and on kinds with no crossing;
   * `entryDirection` (src/alerts/reversion.ts) derives it for old entries.
   */
  direction?: CrossDirection;
  /**
   * Every later crossing of the same alert's level inside the reversion
   * window, oldest first. Folded onto the fire they follow instead of
   * becoming queue entries of their own, so a level price chops back and
   * forth across reads as one event. The first one against `direction` is
   * the reversal.
   */
  followUps?: RevisitFollowUp[];
  /**
   * Set on an entry written before follow-ups were folded, that the
   * migration identified as a follow-up of entry `followUpOf`. Readers skip
   * these; the crossing is already on that entry's `followUps`.
   */
  followUpOf?: string;
}

export interface RevisitFollowUp {
  at: string;
  price: number;
  direction: CrossDirection;
  session: Session | null;
}

export interface RevisitWeights {
  verdict: number;
  volume: number;
  move: number;
  position: number;
  staleness: number;
}

/**
 * Weights sum to 1.0 so `priority` reads as a percentage. Breakout quality
 * leads because it is the only signal that judges whether the move was real;
 * volume is close behind as the independent confirmation of the same thing.
 * Staleness is deliberately the smallest - it is a tiebreaker that keeps the
 * queue from rotting, not a reason to act.
 */
export const DEFAULT_REVISIT_WEIGHTS: RevisitWeights = {
  verdict: 0.3,
  volume: 0.25,
  move: 0.2,
  position: 0.15,
  staleness: 0.1,
};

/** Move that earns a full move score. A 10% run past the level is decisively stale. */
const MOVE_FULL_PCT = 10;
/** Days open that earn a full staleness score. */
const STALENESS_FULL_DAYS = 14;
/** Breakout-day volume multiple that earns a full ratio score. */
const VOLUME_RATIO_FULL = 2.0;
/** Volume-trend multiple that earns a full trend score. */
const VOLUME_TREND_FULL = 1.5;

const VERDICT_SCORES: Record<string, number> = {
  CONFIRMED_BREAKOUT: 1.0,
  WATCH: 0.7,
  WATCH_WEAK: 0.45,
  NO: 0.2,
  NO_CLOSE_CONFIRM: 0.1,
  INSUFFICIENT_DATA: 0,
  SKIPPED: 0,
  PROVIDER_ERROR: 0,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function verdictScore(verdict: string | null): number {
  if (verdict === null) return 0;
  return VERDICT_SCORES[verdict] ?? 0;
}

/**
 * A move past the level scores by how far it went *in the fire's direction*.
 * A downward fire that kept falling is as stale as an upward one that kept
 * rising; reading the raw percent would score it 0. A move back across the
 * level scores nothing either way.
 */
export function moveScore(pctMovePastLevel: number | null, direction: CrossDirection | null = "up"): number {
  if (pctMovePastLevel === null) return 0;
  const past = direction === "down" ? -pctMovePastLevel : pctMovePastLevel;
  return clamp01(past / MOVE_FULL_PCT);
}

export function stalenessScore(daysOpen: number): number {
  return clamp01(daysOpen / STALENESS_FULL_DAYS);
}

/**
 * Blends the size of the volume spike with whether volume was already
 * building into it. A lone freak-volume day scores well below a day that
 * caps a rising trend, which is the same distinction analyzeAlert draws
 * between CONFIRMED_BREAKOUT and WATCH.
 */
export function volumeScore(volumeRatio: number | null, volumeTrendRatio: number | null): number {
  if (volumeRatio === null && volumeTrendRatio === null) return 0;
  const ratioPart = volumeRatio === null ? 0 : clamp01((volumeRatio - 1) / (VOLUME_RATIO_FULL - 1));
  const trendPart = volumeTrendRatio === null ? 0 : clamp01((volumeTrendRatio - 1) / (VOLUME_TREND_FULL - 1));
  if (volumeTrendRatio === null) return ratioPart;
  if (volumeRatio === null) return trendPart;
  return 0.6 * ratioPart + 0.4 * trendPart;
}

export interface ScoreInputs {
  verdict?: string | null;
  pctMovePastLevel?: number | null;
  daysOpen: number;
  heldPosition: boolean;
  volumeRatio?: number | null;
  volumeTrendRatio?: number | null;
  /** Which way the entry fired (`entryDirection`). Null or absent reads the move as upward. */
  direction?: CrossDirection | null;
}

export function scoreRevisit(
  inputs: ScoreInputs,
  weights: RevisitWeights = DEFAULT_REVISIT_WEIGHTS
): { priority: number; signals: RevisitSignals } {
  const verdict = inputs.verdict ?? null;
  const pctMovePastLevel = inputs.pctMovePastLevel ?? null;
  const volumeRatio = inputs.volumeRatio ?? null;
  const volumeTrendRatio = inputs.volumeTrendRatio ?? null;
  const direction = inputs.direction ?? null;

  const signals: RevisitSignals = {
    verdict,
    verdictScore: verdictScore(verdict),
    pctMovePastLevel,
    ...(direction !== null ? { moveDirection: direction } : {}),
    moveScore: moveScore(pctMovePastLevel, direction),
    daysOpen: inputs.daysOpen,
    stalenessScore: stalenessScore(inputs.daysOpen),
    heldPosition: inputs.heldPosition,
    positionScore: inputs.heldPosition ? 1 : 0,
    volumeRatio,
    volumeTrendRatio,
    volumeScore: volumeScore(volumeRatio, volumeTrendRatio),
  };

  const total =
    weights.verdict * signals.verdictScore +
    weights.volume * signals.volumeScore +
    weights.move * signals.moveScore +
    weights.position * signals.positionScore +
    weights.staleness * signals.stalenessScore;

  return { priority: Math.round(total * 1000) / 10, signals };
}

/** Human-readable breakdown of what put an entry where it is in the queue. */
export function explainPriority(signals: RevisitSignals, weights: RevisitWeights = DEFAULT_REVISIT_WEIGHTS): string {
  const parts: string[] = [];
  if (signals.verdict !== null) {
    parts.push(`${signals.verdict} (${(weights.verdict * signals.verdictScore * 100).toFixed(0)}pt)`);
  }
  if (signals.volumeRatio !== null) {
    parts.push(`volume ${signals.volumeRatio.toFixed(2)}x (${(weights.volume * signals.volumeScore * 100).toFixed(0)}pt)`);
  }
  if (signals.pctMovePastLevel !== null) {
    const move = signals.pctMovePastLevel;
    // The sign stays raw (above the level is +) so the number reads the same
    // on every entry; only which side counts as "past" follows the fire.
    const label =
      signals.moveDirection === "down"
        ? move <= 0
          ? `${move.toFixed(1)}% past level`
          : `+${move.toFixed(1)}% back above level`
        : move >= 0
          ? `+${move.toFixed(1)}% past level`
          : `${move.toFixed(1)}% back below level`;
    parts.push(`${label} (${(weights.move * signals.moveScore * 100).toFixed(0)}pt)`);
  }
  if (signals.heldPosition) {
    parts.push(`held position (${(weights.position * 100).toFixed(0)}pt)`);
  }
  parts.push(`${signals.daysOpen}d open (${(weights.staleness * signals.stalenessScore * 100).toFixed(0)}pt)`);
  return parts.join("; ");
}

/**
 * Which way price moved when `alert` fired, read off its pre-trigger state.
 * A static alert crosses away from `lastKnownSide`; a trailing alert on the
 * low (side "below") fires on a bounce up, one on the high on a pullback
 * down; a moving-average cross carries its own event. Volume alerts and
 * moving-average touches have no direction.
 */
export function fireDirection(alert: Alert): CrossDirection | undefined {
  switch (alert.kind) {
    case "static":
      return alert.lastKnownSide === "below" ? "up" : "down";
    case "trailing":
      return alert.side === "below" ? "up" : "down";
    case "ma":
      return alert.lastEvent === "cross_up" ? "up" : alert.lastEvent === "cross_down" ? "down" : undefined;
    case "volume":
      return undefined;
  }
}

export function newRevisitEntry(
  alert: Alert,
  triggerPrice: number,
  at: string,
  session: Session | null = null,
  details: { volume?: RevisitVolume; direction?: CrossDirection } = {}
): RevisitEntry {
  const direction = details.direction ?? fireDirection(alert);
  return {
    id: randomUUID().slice(0, 8),
    alertId: alert.id,
    symbol: alert.symbol,
    kind: alert.kind,
    triggeredAt: at,
    triggerPrice,
    condition: describeAlertCondition(alert),
    ...(details.volume ? { volume: details.volume } : {}),
    ...(direction !== undefined ? { direction } : {}),
    levelAtTrigger:
      alert.kind === "static"
        ? alert.level
        : alert.kind === "trailing"
          ? alert.near
          : alert.kind === "ma"
            ? alert.lastLevel
            : null,
    ...(alert.kind === "ma" && alert.lastEvent !== null
      ? {
          ma: {
            maType: alert.maType,
            period: alert.period,
            timeframe: alert.timeframe,
            event: alert.lastEvent,
            approachedFrom: alert.lastApproachedFrom,
          },
        }
      : {}),
    session,
    watchingSince: alert.watchingSince ?? null,
    watchingSinceApprox: alert.watchingSinceApprox ?? false,
    priceAtWatchStart: alert.priceAtWatchStart ?? null,
    status: "open",
    appliedFrom: null,
    appliedTo: null,
    suggestedLevel: null,
    suggestedAt: null,
    suggestionBasis: null,
    resolvedAt: null,
    priority: null,
    signals: null,
  };
}

export function daysBetween(from: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000));
}
