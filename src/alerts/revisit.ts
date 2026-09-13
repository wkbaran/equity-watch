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
import type { Alert } from "./models.js";

export type RevisitStatus = "open" | "applied" | "dismissed";

export interface RevisitSignals {
  /** Breakout verdict from analysis.ts, once an analyze pass has run over this entry. */
  verdict: string | null;
  verdictScore: number;
  /** How far price has travelled past the level since it fired, in percent. */
  pctMovePastLevel: number | null;
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

export function moveScore(pctMovePastLevel: number | null): number {
  if (pctMovePastLevel === null) return 0;
  return clamp01(pctMovePastLevel / MOVE_FULL_PCT);
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
}

export function scoreRevisit(
  inputs: ScoreInputs,
  weights: RevisitWeights = DEFAULT_REVISIT_WEIGHTS
): { priority: number; signals: RevisitSignals } {
  const verdict = inputs.verdict ?? null;
  const pctMovePastLevel = inputs.pctMovePastLevel ?? null;
  const volumeRatio = inputs.volumeRatio ?? null;
  const volumeTrendRatio = inputs.volumeTrendRatio ?? null;

  const signals: RevisitSignals = {
    verdict,
    verdictScore: verdictScore(verdict),
    pctMovePastLevel,
    moveScore: moveScore(pctMovePastLevel),
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
    const label = move >= 0 ? `+${move.toFixed(1)}% past level` : `${move.toFixed(1)}% back below level`;
    parts.push(`${label} (${(weights.move * signals.moveScore * 100).toFixed(0)}pt)`);
  }
  if (signals.heldPosition) {
    parts.push(`held position (${(weights.position * 100).toFixed(0)}pt)`);
  }
  parts.push(`${signals.daysOpen}d open (${(weights.staleness * signals.stalenessScore * 100).toFixed(0)}pt)`);
  return parts.join("; ");
}

export function newRevisitEntry(
  alert: Alert,
  triggerPrice: number,
  at: string,
  session: Session | null = null
): RevisitEntry {
  return {
    id: randomUUID().slice(0, 8),
    alertId: alert.id,
    symbol: alert.symbol,
    kind: alert.kind,
    triggeredAt: at,
    triggerPrice,
    levelAtTrigger: alert.kind === "static" ? alert.level : alert.kind === "trailing" ? alert.near : null,
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
