import { randomUUID } from "node:crypto";
import type { PriceBar } from "../models.js";
import type { Quote } from "../providers/schwab.js";
import {
  DEFAULT_ALERT_DIRECTION,
  effectiveTrigger,
  type Alert,
  type AlertDirection,
  type AlertSide,
  type CrossDirection,
  type MaAlert,
  type MaApproach,
  type MaTrigger,
  type PriceAlert,
  type StaticAlert,
  type VolumeAlert,
  type VolumeCondition,
  type VolumePeriodUnit,
} from "./models.js";
import type { MaSpec, MaTimeframe, MaType } from "../indicators/movingAverage.js";
import type { Session } from "../marketHours.js";
import { checkMaAlerts, type DailyHistoryResolver } from "./maEngine.js";
import type { Notifier } from "./notify.js";
import { newRevisitEntry, type RevisitEntry, type RevisitFollowUp, type RevisitVolume } from "./revisit.js";
import {
  DEFAULT_REVERSION_WINDOW_DAYS,
  entryDirection,
  latestFireOf,
  reversalOf,
  watchesDirection,
  withinReversionWindow,
} from "./reversion.js";
import { requiredVolume } from "./volumeBaseline.js";
import { nextMarketMidnight } from "../timezone.js";
import { findAlert, loadAlerts, saveAlerts } from "./store.js";

export interface MarketData {
  getQuotes(symbols: string[]): Promise<Map<string, Quote>>;
  /** Minute bars for the last `daysBack` trading sessions. */
  getIntradayBars(symbol: string, daysBack: number): Promise<PriceBar[]>;
  getDailyBars(symbol: string, start: Date, end: Date): Promise<PriceBar[]>;
}

function chartUrl(symbol: string): string {
  return `https://www.tradingview.com/chart/?symbol=${symbol}`;
}

const PERIOD_UNIT_MS: Record<VolumePeriodUnit, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function periodMs(condition: VolumeCondition): number {
  return condition.periodValue! * PERIOD_UNIT_MS[condition.periodUnit!];
}

/**
 * Resolves how many shares a condition currently demands. An absolute
 * threshold answers immediately; a ratio needs the symbol's typical volume for
 * this window, which the caller supplies (and caches - recomputing per poll
 * would mean a bar fetch per volume alert every check).
 */
export type BaselineResolver = (symbol: string, condition: VolumeCondition) => Promise<number | null>;

async function volumeSatisfied(
  condition: VolumeCondition,
  symbol: string,
  todaySoFar: number,
  market: MarketData,
  resolveBaseline: BaselineResolver
): Promise<{ satisfied: boolean; observation: RevisitVolume | null }> {
  const needsBaseline = condition.threshold === undefined;
  const baseline = needsBaseline ? await resolveBaseline(symbol, condition) : null;
  const required = requiredVolume(condition, baseline);
  if (required === null) {
    // No usable threshold - a ratio with no baseline to scale. Treat as
    // unsatisfied rather than letting any volume qualify.
    return { satisfied: false, observation: null };
  }

  // Returned alongside the verdict so a trigger can record what it actually
  // saw ("1.5M shares today vs 1M required"), not just that it fired.
  const observe = (observed: number) => ({
    satisfied: observed >= required,
    observation: {
      observed,
      required: Math.round(required),
      window: condition.mode === "today" ? "today" : `${condition.periodValue}${condition.periodUnit}`,
      basis: needsBaseline ? ("ratio" as const) : ("threshold" as const),
    },
  });

  if (condition.mode === "today") {
    return observe(todaySoFar);
  }

  const windowMs = periodMs(condition);
  const windowStart = Date.now() - windowMs;

  if (condition.periodUnit === "d") {
    const bars = await market.getDailyBars(symbol, new Date(windowStart), new Date());
    return observe(bars.reduce((sum, b) => sum + b.volume, 0));
  }

  // Sub-day periods: Schwab's REST history floors out at 1-minute bars, so
  // fetch enough trailing days to cover the window and filter client-side.
  const daysBack = Math.min(10, Math.max(2, Math.ceil(windowMs / PERIOD_UNIT_MS.d) + 1));
  const bars = await market.getIntradayBars(symbol, daysBack);
  return observe(bars.filter((b) => b.date.getTime() >= windowStart).reduce((sum, b) => sum + b.volume, 0));
}

/**
 * How long to suppress re-firing after a volume condition is satisfied.
 * A volume threshold, once crossed, stays crossed - without this the alert
 * would fire on every poll for the rest of the window. Price crossings need
 * no equivalent: they are already self-limiting via lastKnownSide (static)
 * and extremePrice (trailing).
 */
function muteUntilFor(condition: VolumeCondition, now: Date): string {
  if (condition.mode === "today") {
    // The trading day's volume keeps accumulating through after-hours, so the
    // mute must last until the exchange's midnight. UTC midnight is 19:00
    // Eastern in winter, which would re-fire the same day's alert in post-market.
    return nextMarketMidnight(now).toISOString();
  }
  return new Date(now.getTime() + periodMs(condition)).toISOString();
}

/** A crossing folded onto an earlier fire instead of becoming a queue entry. */
export interface FollowUpEvent {
  alert: StaticAlert;
  /** The fire it was folded onto, already carrying `followUp`. */
  entry: RevisitEntry;
  followUp: RevisitFollowUp;
  /** True for the first follow-up against the fire's direction. */
  reversal: boolean;
}

export interface CheckOptions {
  /**
   * The revisit queue as stored. Static crossings look here for the fire they
   * follow, and follow-ups are appended onto these objects in place. Without
   * it every watched crossing fires and nothing is folded.
   */
  existingRevisits?: RevisitEntry[];
  /** Trading days a fire folds later crossings for. See reversionWindowFor. */
  reversionWindowDays?: (symbol: string) => number;
  /** The check's clock. Tests pin it; everything else uses the real time. */
  now?: Date;
}

export interface CheckResult {
  checked: number;
  triggered: Alert[];
  /** New entries, one per fire. Append these to the store. */
  revisits: RevisitEntry[];
  /** Crossings folded onto earlier fires, in the order they were seen. */
  followUps: FollowUpEvent[];
  /** Entries from `existingRevisits` that gained a follow-up. The store needs re-saving when non-empty. */
  updatedRevisits: RevisitEntry[];
  warnings: string[];
}

export async function checkAlerts(
  alerts: Alert[],
  market: MarketData,
  notifiers: Notifier[],
  session: Session | null = null,
  /** Symbols to leave alone entirely - see TuningConfig.ignoreSymbols. */
  ignored: Set<string> = new Set(),
  /** Supplies typical volume for ratio-based conditions. */
  resolveBaseline: BaselineResolver = async () => null,
  /** Supplies daily history for 1D/1W moving averages. The CLI's version caches per market date. */
  resolveDailyHistory: DailyHistoryResolver = (symbol, days) =>
    market.getDailyBars(symbol, new Date(Date.now() - days * 86_400_000), new Date()),
  options: CheckOptions = {}
): Promise<CheckResult> {
  const live = alerts.filter((a) => a.status === "live" && !ignored.has(a.symbol.toUpperCase()));
  const symbols = [...new Set(live.map((a) => a.symbol))];
  const quotes = await market.getQuotes(symbols);

  const existing = options.existingRevisits ?? [];
  const windowFor = options.reversionWindowDays ?? (() => DEFAULT_REVERSION_WINDOW_DAYS);
  const triggered: Alert[] = [];
  const revisits: RevisitEntry[] = [];
  const followUps: FollowUpEvent[] = [];
  const updated = new Set<RevisitEntry>();
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();

  for (const alert of live) {
    // Moving-average alerts are path-evaluated in one batch below.
    if (alert.kind === "ma") {
      continue;
    }
    const quote = quotes.get(alert.symbol);
    if (quote === undefined) {
      continue;
    }
    const currentPrice = quote.lastPrice;
    // The mute exists so a satisfied volume condition doesn't fire on every
    // poll. It only gates firing: a static crossing during a mute is still a
    // real crossing, so it is still folded onto its fire or allowed to move
    // lastKnownSide below. Skipping those would leave lastKnownSide pointing
    // at a side price left long ago.
    const muted = alert.mutedUntil !== null && alert.mutedUntil > now;
    let cross: CrossDirection | undefined;

    let priceConditionMet: boolean;
    if (alert.kind === "volume") {
      if (muted) continue;
      priceConditionMet = true;
    } else if (alert.kind === "static") {
      const currentSide: AlertSide = currentPrice > alert.level ? "above" : "below";
      if (currentSide === alert.lastKnownSide) {
        // No crossing. lastKnownSide is deliberately left alone - see the
        // volume-gating comment below for why.
        continue;
      }
      cross = currentSide === "above" ? "up" : "down";

      // Inside a fire's window, every crossing (either direction, muted or
      // not) belongs to that fire. It never fires on its own and never waits
      // on volume: volume was the fire's condition, and it was met.
      const fire = latestFireOf([...existing, ...revisits], alert.id, alert.level);
      if (fire !== null && withinReversionWindow(fire.triggeredAt, nowDate, windowFor(alert.symbol))) {
        const reversal = cross !== entryDirection(fire) && reversalOf(fire) === null;
        const followUp: RevisitFollowUp = { at: now, price: currentPrice, direction: cross, session };
        fire.followUps = [...(fire.followUps ?? []), followUp];
        if (existing.includes(fire)) {
          updated.add(fire);
        }
        alert.lastKnownSide = currentSide;
        followUps.push({ alert, entry: fire, followUp, reversal });
        continue;
      }

      if (!watchesDirection(alert.direction, cross)) {
        // A crossing this alert doesn't watch, with no fire to revert: nothing
        // to record, but the next watched crossing must be measured from here.
        alert.lastKnownSide = currentSide;
        continue;
      }
      if (muted) {
        // Same as a volume-pending crossing: lastKnownSide stays stale, so it
        // fires once the mute lapses if price is still across.
        continue;
      }
      priceConditionMet = true;
    } else if (muted) {
      continue;
    } else if (alert.side === "below") {
      if (currentPrice < alert.extremePrice) {
        alert.extremePrice = currentPrice;
        alert.extremeAt = now;
        priceConditionMet = false;
      } else {
        priceConditionMet = currentPrice >= effectiveTrigger(alert);
      }
    } else {
      if (currentPrice > alert.extremePrice) {
        alert.extremePrice = currentPrice;
        alert.extremeAt = now;
        priceConditionMet = false;
      } else {
        priceConditionMet = currentPrice <= effectiveTrigger(alert);
      }
    }

    if (!priceConditionMet) {
      continue;
    }

    const condition = alert.kind === "volume" ? alert.volume : alert.volumeCondition;
    const volumeCheck = condition
      ? await volumeSatisfied(condition, alert.symbol, quote.totalVolume, market, resolveBaseline)
      : null;

    if (volumeCheck !== null && !volumeCheck.satisfied) {
      // Price condition met but volume hasn't caught up yet. For static
      // alerts specifically, deliberately leave lastKnownSide stale so this
      // stays "pending" across checks until volume qualifies OR price fully
      // reverts (at which point currentSide naturally matches the stale
      // lastKnownSide again on some later check, quietly resolving it).
      continue;
    }

    // Snapshot and queue the revisit entry from the pre-re-arm state, so both
    // record what the alert looked like when it fired rather than what it
    // looks like after being set up to watch again.
    const snapshot = { ...alert, triggerSnapshot: null } as Alert;
    revisits.push(
      newRevisitEntry(snapshot, currentPrice, now, session, {
        volume: volumeCheck?.observation ?? undefined,
        direction: cross,
      })
    );

    alert.triggerSnapshot = snapshot;
    alert.triggerCount += 1;
    alert.lastTriggeredAt = now;
    alert.lastTriggerPrice = currentPrice;

    // The alert does not disarm. Set it up to watch again from here:
    // a static alert goes quiet until price genuinely re-crosses its level,
    // and a trailing alert starts trailing afresh from the current price.
    if (alert.kind === "static") {
      alert.lastKnownSide = currentPrice > alert.level ? "above" : "below";
    } else if (alert.kind === "trailing") {
      alert.extremePrice = currentPrice;
      alert.extremeAt = now;
    }
    alert.mutedUntil = condition ? muteUntilFor(condition, nowDate) : null;

    triggered.push(alert);
    for (const notifier of notifiers) {
      await notifier.notify({ alert, currentPrice, chartUrl: chartUrl(alert.symbol) });
    }
  }

  const warnings: string[] = [];
  const maAlerts = live.filter((a): a is MaAlert => a.kind === "ma");
  if (maAlerts.length > 0) {
    const ma = await checkMaAlerts(maAlerts, quotes, market, resolveDailyHistory, nowDate);
    warnings.push(...ma.warnings);
    for (const { alert, evaluation } of ma.results) {
      if (evaluation.event === null) {
        continue;
      }
      // Recorded at the point it happened, which may be minutes before this check.
      const at = evaluation.at!.toISOString();
      const price = evaluation.price!;
      alert.lastEvent = evaluation.event;
      alert.lastApproachedFrom = evaluation.approachedFrom;
      alert.lastLevel = evaluation.level;

      const snapshot = { ...alert, triggerSnapshot: null } as Alert;
      revisits.push(newRevisitEntry(snapshot, price, at, session));
      alert.triggerSnapshot = snapshot;
      alert.triggerCount += 1;
      alert.lastTriggeredAt = at;
      alert.lastTriggerPrice = price;

      triggered.push(alert);
      for (const notifier of notifiers) {
        await notifier.notify({ alert, currentPrice: price, chartUrl: chartUrl(alert.symbol) });
      }
    }
  }

  return { checked: live.length, triggered, revisits, followUps, updatedRevisits: [...updated], warnings };
}

/** Backdates an imported alert to when it was really first watched. */
export interface WatchOrigin {
  since: string;
  approximate: boolean;
  priceAtStart: number | null;
}

export type AddAlertInput =
  | {
      kind: "static";
      symbol: string;
      level: number;
      /** Which crossings fire. Defaults to DEFAULT_ALERT_DIRECTION. */
      direction?: AlertDirection;
      volume?: VolumeCondition;
      watching?: WatchOrigin;
    }
  | {
      kind: "trailing";
      symbol: string;
      near: number;
      trailType: "percent" | "amount";
      trailValue: number;
      volume?: VolumeCondition;
      watching?: WatchOrigin;
    }
  | { kind: "volume"; symbol: string; volume: VolumeCondition; watching?: WatchOrigin }
  | {
      kind: "ma";
      symbol: string;
      maType: MaType;
      period: number;
      timeframe: MaTimeframe;
      trigger: MaTrigger;
      from: MaApproach;
      marginPct: number;
      watching?: WatchOrigin;
    };

export interface AddAlertResult {
  added: Alert | null;
  replaced: Alert | null;
  rejectedReason: string | null;
}

export interface AddAlertOptions {
  /**
   * What to do when a live alert already watches this symbol on this side.
   *
   * - `keep-closest` (the default) rejects a candidate that sits farther from
   *   the live price than the alert already there. That is what a bulk import
   *   wants: `alert seed` re-levels hundreds of rows and must not talk an
   *   existing, nearer alert down to a level price has to travel further to
   *   reach.
   * - `replace` always cancels the incumbent. A typed `alert add` is a stated
   *   intention, not a suggestion — the user is moving the level, and a
   *   rejection there just means typing `alert remove` first.
   */
  onConflict?: "keep-closest" | "replace";
}

export async function addAlert(
  path: string,
  input: AddAlertInput,
  market: MarketData,
  options: AddAlertOptions = {}
): Promise<AddAlertResult> {
  const quotes = await market.getQuotes([input.symbol]);
  const quote = quotes.get(input.symbol);
  if (quote === undefined) {
    return { added: null, replaced: null, rejectedReason: `No quote available for ${input.symbol}.` };
  }
  const livePrice = quote.lastPrice;

  const now = new Date().toISOString();
  const baseFields = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    status: "live" as const,
    createdAt: now,
    livePriceAtCreation: livePrice,
    watchingSince: input.watching?.since ?? now,
    watchingSinceApprox: input.watching?.approximate ?? false,
    priceAtWatchStart: input.watching?.priceAtStart ?? livePrice,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    triggerSnapshot: null,
  };

  // Volume-only alerts have no price anchor/side, so they sit outside the
  // above/below uniqueness rule entirely - always just added.
  if (input.kind === "volume") {
    const candidate: Alert = { ...baseFields, kind: "volume", volume: input.volume };
    const alerts = loadAlerts(path);
    alerts.push(candidate);
    saveAlerts(path, alerts);
    return { added: candidate, replaced: null, rejectedReason: null };
  }

  // Moving-average alerts are likewise outside the uniqueness rule: a 9-day
  // and a 200-week average on one symbol are different things to watch. State
  // starts empty and seeds on the first check.
  if (input.kind === "ma") {
    const candidate: MaAlert = {
      ...baseFields,
      kind: "ma",
      maType: input.maType,
      period: input.period,
      timeframe: input.timeframe,
      trigger: input.trigger,
      from: input.from,
      marginPct: input.marginPct,
      lastSide: null,
      inBand: false,
      lastLevel: null,
      lastEvaluatedAt: null,
      lastFiredBucket: null,
      lastEvent: null,
      lastApproachedFrom: null,
    };
    const alerts = loadAlerts(path);
    alerts.push(candidate);
    saveAlerts(path, alerts);
    return { added: candidate, replaced: null, rejectedReason: null };
  }

  const anchor = input.kind === "static" ? input.level : input.near;
  if (anchor === livePrice) {
    return {
      added: null,
      replaced: null,
      rejectedReason: `Reference price ${anchor} equals the live price (${livePrice}); pick a distinct one.`,
    };
  }
  const side: AlertSide = anchor < livePrice ? "below" : "above";
  const base = { ...baseFields, side };

  const candidate: PriceAlert =
    input.kind === "static"
      ? {
          ...base,
          kind: "static",
          direction: input.direction ?? DEFAULT_ALERT_DIRECTION,
          level: input.level,
          lastKnownSide: livePrice > input.level ? "above" : "below",
          ...(input.volume ? { volumeCondition: input.volume } : {}),
        }
      : {
          ...base,
          kind: "trailing",
          near: input.near,
          trailType: input.trailType,
          trailValue: input.trailValue,
          extremePrice: input.near,
          extremeAt: now,
          ...(input.volume ? { volumeCondition: input.volume } : {}),
        };

  const candidateDistance = Math.abs(livePrice - effectiveTrigger(candidate));

  const alerts = loadAlerts(path);
  const existing = alerts.find(
    (a): a is PriceAlert =>
      (a.kind === "static" || a.kind === "trailing") && a.status === "live" && a.symbol === input.symbol && a.side === side
  );

  if (existing) {
    const existingDistance = Math.abs(livePrice - effectiveTrigger(existing));
    if (options.onConflict !== "replace" && candidateDistance > existingDistance) {
      return {
        added: null,
        replaced: null,
        rejectedReason:
          `Existing ${existing.kind} alert ${existing.id} (trigger ${effectiveTrigger(existing)}) is ` +
          `already closer to the live price than this one would be (trigger ${effectiveTrigger(candidate)}).`,
      };
    }
    existing.status = "cancelled";
  }

  alerts.push(candidate);
  saveAlerts(path, alerts);
  return { added: candidate, replaced: existing ?? null, rejectedReason: null };
}

/** What `editAlert` may change. Omitted fields are left as they are. */
export interface AlertEdit {
  /**
   * Static, or a volume alert gaining a price level, which makes it a static
   * alert with its volume as the AND condition. Null drops a static alert's
   * level, which leaves a volume alert and so needs a volume condition.
   */
  level?: number | null;
  /** Static: up, down, or either. Moving-average cross: up or down. */
  direction?: AlertDirection;
  /** Trailing only. */
  trail?: { type: "percent" | "amount"; value: number };
  /** A replacement volume condition, or null to remove it. Not on moving averages. */
  volume?: VolumeCondition | null;
  /** Moving average only. Restarts its evaluation, as if newly added. */
  ma?: MaSpec;
  /** Moving-average touch only. */
  marginPct?: number;
  /** Moving-average touch only. */
  from?: MaApproach;
}

export interface EditAlertResult {
  /** The alert as it was. Null when rejected. */
  before: Alert | null;
  edited: Alert | null;
  /** A live alert on the same symbol and side, cancelled because the moved level is closer to price. */
  replaced: Alert | null;
  rejectedReason: string | null;
}

const EDITABLE_KINDS: Record<keyof AlertEdit, { label: string; kinds: Alert["kind"][] }> = {
  level: { label: "level", kinds: ["static", "volume"] },
  direction: { label: "direction", kinds: ["static", "ma", "volume"] },
  trail: { label: "trail", kinds: ["trailing"] },
  volume: { label: "volume condition", kinds: ["static", "trailing", "volume"] },
  ma: { label: "moving average", kinds: ["ma"] },
  marginPct: { label: "touch margin", kinds: ["ma"] },
  from: { label: "approach side", kinds: ["ma"] },
};

/**
 * Changes an alert in place, keeping its id, watch start, and trigger history.
 *
 * Price and volume are one form on the page, whatever the alert's kind, so an
 * edit may move an alert between static and volume-only: a level added to a
 * volume alert makes it a static alert whose volume is the AND condition, and
 * a static alert's level dropped leaves its volume condition standing alone.
 * `triggerSnapshot` and the revisit entries already record what it looked like
 * when it fired, so an edit doesn't rewrite that.
 *
 * Only a moved static level needs a quote: the side, the crossing baseline,
 * and the one-alert-per-symbol+side rule all depend on where price is. Other
 * edits work without reaching Schwab.
 */
export async function editAlert(path: string, ref: string, edit: AlertEdit, market: MarketData): Promise<EditAlertResult> {
  const reject = (reason: string): EditAlertResult => ({ before: null, edited: null, replaced: null, rejectedReason: reason });

  const alerts = loadAlerts(path);
  const found = findAlert(alerts, ref);
  if (found.alert === null) {
    return reject(found.error);
  }
  let alert = found.alert;
  if (alert.status !== "live") {
    return reject(`Alert ${alert.id} is ${alert.status}. Add a new alert instead.`);
  }
  const fields = (Object.keys(edit) as (keyof AlertEdit)[]).filter((k) => edit[k] !== undefined);
  if (fields.length === 0) {
    return reject("Nothing to change.");
  }
  const unsupported = fields.filter((k) => !EDITABLE_KINDS[k].kinds.includes(alert.kind));
  if (unsupported.length > 0) {
    return reject(
      `A ${alert.kind} alert has no ${unsupported.map((k) => EDITABLE_KINDS[k].label).join(" or ")} to edit. ` +
        `To change its kind, remove it and add a new one.`
    );
  }
  const before = structuredClone(alert);
  let replaced: Alert | null = null;

  if (alert.kind === "volume") {
    if (edit.level === null) {
      return reject("A volume alert has no price level to remove.");
    }
    if (edit.level === undefined) {
      if (edit.direction !== undefined) {
        return reject("A volume alert has no direction. Give it a level too, and the direction applies to that.");
      }
    } else {
      // Becomes a static alert. The level, side, and crossing baseline are set
      // below exactly as for any moved level; its volume becomes the AND
      // condition unless this edit replaces or clears that too.
      const { kind: _kind, volume, ...base } = alert;
      const promoted: StaticAlert = {
        ...base,
        kind: "static",
        side: "above",
        direction: DEFAULT_ALERT_DIRECTION,
        level: edit.level,
        lastKnownSide: "above",
        volumeCondition: volume,
        mutedUntil: null,
      };
      alerts[alerts.indexOf(alert)] = promoted;
      alert = promoted;
    }
  }

  if (alert.kind === "ma") {
    const trigger = alert.trigger;
    if (edit.direction !== undefined) {
      if (trigger === "touch") {
        return reject("A touch alert has no direction. Set the side it approaches from instead.");
      }
      if (edit.direction === "either") {
        return reject("A moving-average cross watches up or down, not either.");
      }
      alert.from = edit.direction === "up" ? "below" : "above";
    }
    if (trigger === "cross" && (edit.from !== undefined || edit.marginPct !== undefined)) {
      return reject("A cross alert has no touch margin or approach side. Set its direction instead.");
    }
    if (edit.from !== undefined) {
      alert.from = edit.from;
    }
    if (edit.marginPct !== undefined) {
      alert.marginPct = edit.marginPct;
    }
    if (edit.ma !== undefined) {
      alert.maType = edit.ma.maType;
      alert.period = edit.ma.period;
      alert.timeframe = edit.ma.timeframe;
      // A different average: its old side and band say nothing about this one.
      alert.lastSide = null;
      alert.inBand = false;
      alert.lastLevel = null;
      alert.lastEvaluatedAt = null;
      alert.lastFiredBucket = null;
    }
  }

  if (edit.volume !== undefined) {
    if (alert.kind === "volume") {
      if (edit.volume === null) {
        return reject("A volume alert can't lose its volume condition. Remove the alert instead.");
      }
      alert.volume = edit.volume;
    } else if (alert.kind === "static" || alert.kind === "trailing") {
      if (edit.volume === null) {
        delete alert.volumeCondition;
        // Only a volume condition ever sets a mute.
        alert.mutedUntil = null;
      } else {
        alert.volumeCondition = edit.volume;
      }
    }
  }

  if (alert.kind === "trailing" && edit.trail !== undefined) {
    alert.trailType = edit.trail.type;
    alert.trailValue = edit.trail.value;
  }

  if (alert.kind === "static" && edit.level === null) {
    // Becomes a volume alert: its volume condition, after this edit's own
    // change to it, is all that is left to watch.
    if (edit.direction !== undefined) {
      return reject("A direction needs a level. Keep the level, or drop the direction change.");
    }
    const { kind: _kind, side: _side, direction: _direction, level: _level, lastKnownSide: _lastKnownSide, volumeCondition, ...base } = alert;
    if (volumeCondition === undefined) {
      return reject("Without a level or a volume condition the alert would watch nothing. Remove it instead.");
    }
    const demoted: VolumeAlert = { ...base, kind: "volume", volume: volumeCondition, mutedUntil: null };
    alerts[alerts.indexOf(alert)] = demoted;
    alert = demoted;
  }

  if (alert.kind === "static") {
    if (edit.direction !== undefined) {
      alert.direction = edit.direction;
    }
    if (edit.level !== undefined && edit.level !== null) {
      const quote = (await market.getQuotes([alert.symbol])).get(alert.symbol);
      if (quote === undefined) {
        return reject(`No quote available for ${alert.symbol}.`);
      }
      const livePrice = quote.lastPrice;
      if (edit.level === livePrice) {
        return reject(`Level ${edit.level} equals the live price (${livePrice}); pick a distinct one.`);
      }
      alert.level = edit.level;
      alert.side = edit.level < livePrice ? "below" : "above";
      // Re-seed against the new level, as `revisit apply` does, so the move
      // itself neither fires the alert nor hides a crossing.
      alert.lastKnownSide = livePrice > edit.level ? "above" : "below";
      alert.mutedUntil = null;

      const rival = alerts.find(
        (a): a is PriceAlert =>
          (a.kind === "static" || a.kind === "trailing") &&
          a.id !== alert.id &&
          a.status === "live" &&
          a.symbol === alert.symbol &&
          a.side === alert.side
      );
      if (rival) {
        if (Math.abs(livePrice - effectiveTrigger(alert)) > Math.abs(livePrice - effectiveTrigger(rival))) {
          return reject(
            `Existing ${rival.kind} alert ${rival.id} (trigger ${effectiveTrigger(rival)}) is already closer to ` +
              `the live price on that side than level ${edit.level} would be.`
          );
        }
        rival.status = "cancelled";
        replaced = rival;
      }
    }
  }

  saveAlerts(path, alerts);
  return { before, edited: alert, replaced, rejectedReason: null };
}
