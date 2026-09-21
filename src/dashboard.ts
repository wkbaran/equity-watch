/**
 * The periodic dashboard document.
 *
 * The three existing report writers (breakout_report_*, alert_triggers_*,
 * holdings_alerts_*) are event logs: they are only written when something
 * fired, and each covers one subsystem. A dashboard needs the opposite - one
 * document, emitted on a schedule, that is just as meaningful on a quiet day
 * as on a busy one. So this always renders four things:
 *
 *   1. what needs a decision   (the revisit queue, priority-ranked)
 *   2. what is about to happen (live alerts closest to firing)
 *   3. what is being watched   (coverage totals)
 *   4. what is actually held   (positions against basis)
 *
 * JSON rather than CSV: this is a nested document with per-row signal
 * breakdowns, and it is meant to be fed to something, not opened in a
 * spreadsheet. The CSV writers stay as they are for the event logs.
 */

import { effectiveTrigger, type Alert, type AlertDirection, type CrossDirection } from "./alerts/models.js";
import { describeAlertCondition } from "./alerts/describe.js";
import { entryDirection, reversalOf, tradingDaysAfter } from "./alerts/reversion.js";
import {
  explainPriority,
  type RevisitEntry,
  type RevisitFollowUp,
  type RevisitMa,
  type RevisitVolume,
} from "./alerts/revisit.js";
import { computeBasis, type HoldingsStore } from "./holdings/models.js";
import type { Session } from "./marketHours.js";
import {
  buildStories,
  quietWatchNote,
  sinceWatchingNote,
  triggerAction,
  triggerHeadline,
  type NarrativeContext,
  type TickerStory,
} from "./narrative.js";
import type { Quote } from "./providers/schwab.js";
import { mapExchange, tradingViewUrl } from "./tradingview.js";

export interface DashboardSummary {
  liveAlerts: number;
  symbolsWatched: number;
  openRevisits: number;
  /** Open entries that already carry a proposed level, i.e. actionable right now. */
  actionableRevisits: number;
  triggersInWindow: number;
  windowDays: number;
  positions: number;
  quotesUnavailable: number;
}

/**
 * The first crossing back against a fire, precomputed so a renderer doesn't
 * need the trading calendar. Recorded events only, nothing relative to now.
 */
export interface ReversalSummary {
  at: string;
  price: number;
  /** Trading days after the fire's own day: 0 is the same day. */
  tradingDaysAfter: number;
}

/** Fields every row describing one fire carries about the crossing and what followed it. */
export interface CrossingDetails {
  /** Which way price crossed the level. Null for volume triggers and moving-average touches. */
  direction: CrossDirection | null;
  /** Later crossings of the same level inside the reversion window, oldest first. */
  followUps: RevisitFollowUp[];
  reversal: ReversalSummary | null;
}

export interface RevisitRow extends CrossingDetails {
  id: string;
  /** The alert that fired. The browser dashboard edits it from this row's details panel. */
  alertId: string;
  symbol: string;
  priority: number | null;
  /** Plain-English one-liner: "TGT crossed above 110 on volume and held". */
  headline: string;
  /** What it's waiting on, as a sentence. Null when nothing is pending. */
  action: string | null;
  /** How the name has done since you first started watching it. */
  sinceWatching: string | null;
  session: Session | null;
  verdict: string | null;
  triggeredAt: string;
  triggerPrice: number;
  levelAtTrigger: number | null;
  suggestedLevel: number | null;
  suggestionBasis: string | null;
  daysOpen: number | null;
  why: string | null;
  heldPosition: boolean;
  chartUrl: string;
}

/**
 * One firing, in time order. Distinct from RevisitRow because the queue is
 * priority-sorted, capped, and open-only: a low-priority trigger can land
 * below the cap and a dismissed one vanishes from it. Anything that needs to
 * notice "something new fired" (the browser dashboard's notifications) has
 * to diff against this list, not the queue.
 *
 * Also carries everything a trigger's detail view shows, so a renderer never
 * needs the stores themselves.
 */
export interface TriggerRow extends CrossingDetails {
  id: string;
  alertId: string;
  symbol: string;
  kind: Alert["kind"];
  headline: string;
  triggeredAt: string;
  triggerPrice: number;
  levelAtTrigger: number | null;
  session: Session | null;
  status: RevisitEntry["status"];
  resolvedAt: string | null;
  /** The level before and after the edit that closed it, when that moved it. */
  appliedFrom: number | null;
  appliedTo: number | null;
  priority: number | null;
  heldPosition: boolean;
  chartUrl: string;
  /** The alert's condition in words. */
  condition: string | null;
  /**
   * "recorded": captured when it fired. "current": the entry predates that, so
   * this is the alert as it is now, which may differ. Null when neither exists
   * (an old entry whose alert has since been removed).
   */
  conditionSource: "recorded" | "current" | null;
  /** Whether the alert still exists in the store (live or cancelled). */
  alertExists: boolean;
  /** Observed vs. required volume at trigger time, when that was recorded. */
  volume: RevisitVolume | null;
  verdict: string | null;
  pctMovePastLevel: number | null;
  volumeRatio: number | null;
  volumeTrendRatio: number | null;
  why: string | null;
  suggestedLevel: number | null;
  suggestionBasis: string | null;
  watchingSince: string | null;
  watchingSinceApprox: boolean;
  sinceWatching: string | null;
  ma: RevisitMa | null;
}

export interface ApproachingRow {
  alertId: string;
  symbol: string;
  kind: Alert["kind"];
  side: string | null;
  /** Which crossings fire a static alert. Null for other kinds. */
  direction: AlertDirection | null;
  trigger: number | null;
  price: number;
  /** Percent price must move to fire. Negative means the condition is already met but gated on volume. */
  distancePct: number | null;
  hasVolumeCondition: boolean;
  triggerCount: number;
  chartUrl: string;
}

export interface HoldingRow {
  symbol: string;
  shares: number;
  basis: number;
  price: number | null;
  pctFromBasis: number | null;
  marketValue: number | null;
  lastPurchaseDate: string;
  stops: number[];
  /**
   * Distinct account labels across this symbol's lots, sorted. A row blends
   * every account (computeBasis does), so this is a list, not a field: one
   * symbol really can sit in two accounts. Lots with no label contribute
   * nothing, so an empty array means "none of the lots say".
   */
  accounts: string[];
  /** Held but excluded from alerting — cash parking, not a conviction position. */
  ignored: boolean;
}

export interface Dashboard {
  generatedAt: string;
  summary: DashboardSummary;
  revisitQueue: RevisitRow[];
  /**
   * Every trigger in the window regardless of status, plus older ones still
   * open (so every queue row has details to open), newest first.
   */
  recentTriggers: TriggerRow[];
  approaching: ApproachingRow[];
  /** How many alerts were within range in total, before the display cap. */
  approachingTotal: number;
  holdings: HoldingRow[];
  /** Multi-trigger threads told as a narrative, most active first. */
  stories: TickerStory[];
  /** Long-watched names that have never fired here and have barely moved. */
  quietWatches: string[];
  /** How many qualified in total, before the display cap. */
  quietTotal: number;
  /**
   * TradingView exchange prefix by symbol, for symbols shown without a row
   * carrying a chartUrl (holdings, stories, quiet notes). Symbols with no
   * known exchange are absent; a renderer links them bare.
   */
  tradingViewPrefixes: Record<string, string>;
}

export interface DashboardInputs {
  alerts: Alert[];
  revisits: RevisitEntry[];
  holdings: HoldingsStore;
  quotes: Map<string, Quote>;
  now: Date;
  /** How many days back "recent triggers" counts. */
  windowDays?: number;
  /** Cap on rows in the queue and approaching lists. */
  limit?: number;
  /** Only list alerts within this percent of firing. */
  approachingWithinPct?: number;
  /** Cap on ticker stories. */
  storyLimit?: number;
  /**
   * Include the "approaching" list. Off by default: on a 500-alert book a
   * hundred names sit within a few percent of firing at any moment, which is
   * a readout of market noise rather than anything to act on. The queue says
   * what actually happened; that is the part worth a glance.
   */
  includeApproaching?: boolean;
  /** Symbols excluded from alerting (TuningConfig.ignoreSymbols). */
  ignoredSymbols?: Set<string>;
  /** Symbol to FMP exchange (exchangesFromProfiles), so chart links open the right listing. */
  exchanges?: Map<string, string>;
}

const RECENT_TRIGGER_CAP = 100;

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function crossingDetails(e: RevisitEntry): CrossingDetails {
  const reversal = reversalOf(e);
  return {
    direction: entryDirection(e),
    followUps: e.followUps ?? [],
    reversal:
      reversal === null
        ? null
        : {
            at: reversal.at,
            price: reversal.price,
            tradingDaysAfter: tradingDaysAfter(new Date(e.triggeredAt), new Date(reversal.at)),
          },
  };
}

export function buildDashboard(inputs: DashboardInputs): Dashboard {
  const { alerts, holdings, quotes, now } = inputs;
  // Legacy follow-up entries are already folded onto the fire they follow
  // (its followUps). Counting or listing them again would show one level's
  // chop as several triggers, which is what folding exists to stop.
  const revisits = inputs.revisits.filter((e) => e.followUpOf === undefined);
  const windowDays = inputs.windowDays ?? 7;
  const limit = inputs.limit ?? 25;
  const withinPct = inputs.approachingWithinPct ?? 5;

  const ignored = inputs.ignoredSymbols ?? new Set<string>();
  const isIgnored = (symbol: string) => ignored.has(symbol.toUpperCase());
  const exchanges = inputs.exchanges ?? new Map<string, string>();
  const chartUrl = (symbol: string) => tradingViewUrl(symbol, exchanges.get(symbol));

  const live = alerts.filter((a) => a.status === "live" && !isIgnored(a.symbol));
  const heldSymbols = new Set(holdings.lots.map((l) => l.symbol.toUpperCase()));

  const narrativeCtx: NarrativeContext = { heldSymbols };
  const open = revisits.filter((e) => e.status === "open" && !isIgnored(e.symbol));
  const revisitQueue: RevisitRow[] = [...open]
    .sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1))
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      alertId: e.alertId,
      symbol: e.symbol,
      priority: e.priority,
      headline: triggerHeadline(e, narrativeCtx),
      action: triggerAction(e),
      sinceWatching: sinceWatchingNote(
        e.watchingSince ?? null,
        e.priceAtWatchStart ?? null,
        quotes.get(e.symbol)?.lastPrice ?? e.triggerPrice,
        e.watchingSinceApprox ?? false
      ),
      session: e.session ?? null,
      verdict: e.signals?.verdict ?? null,
      triggeredAt: e.triggeredAt,
      triggerPrice: e.triggerPrice,
      levelAtTrigger: e.levelAtTrigger,
      suggestedLevel: e.suggestedLevel,
      suggestionBasis: e.suggestionBasis,
      daysOpen: e.signals?.daysOpen ?? null,
      why: e.signals ? explainPriority(e.signals) : null,
      heldPosition: heldSymbols.has(e.symbol.toUpperCase()),
      chartUrl: chartUrl(e.symbol),
      ...crossingDetails(e),
    }));

  const includeApproaching = inputs.includeApproaching ?? false;
  let quotesUnavailable = 0;
  const approaching: ApproachingRow[] = [];
  for (const alert of live) {
    const quote = quotes.get(alert.symbol);
    if (quote === undefined) {
      quotesUnavailable++;
      continue;
    }
    const price = quote.lastPrice;

    // A moving-average alert's level is recomputed from bars at check time;
    // the dashboard has no bars, and a stale lastLevel would misstate distance.
    if (alert.kind === "ma") {
      continue;
    }

    // Volume-only alerts have no price distance to report, but they are still
    // live and worth showing, so they carry a null distance rather than being
    // dropped from the picture entirely.
    if (alert.kind === "volume") {
      approaching.push({
        alertId: alert.id,
        symbol: alert.symbol,
        kind: alert.kind,
        side: null,
        direction: null,
        trigger: null,
        price,
        distancePct: null,
        hasVolumeCondition: true,
        triggerCount: alert.triggerCount,
        chartUrl: chartUrl(alert.symbol),
      });
      continue;
    }

    const trigger = effectiveTrigger(alert);
    // Signed so that it always reads as "how far price still has to move",
    // regardless of which side of the level the alert is watching for.
    const distancePct = price === 0 ? null : round(((trigger - price) / price) * 100 * (alert.side === "below" ? -1 : 1));
    if (distancePct !== null && distancePct > withinPct) {
      continue;
    }
    approaching.push({
      alertId: alert.id,
      symbol: alert.symbol,
      kind: alert.kind,
      side: alert.side,
      direction: alert.kind === "static" ? alert.direction : null,
      trigger: round(trigger),
      price,
      distancePct,
      hasVolumeCondition: alert.volumeCondition !== undefined,
      triggerCount: alert.triggerCount,
      chartUrl: chartUrl(alert.symbol),
    });
  }
  approaching.sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity));
  // A 500-alert book puts a hundred names within a few percent of firing,
  // which is unreadable on a small display. Keep the nearest and report the
  // total so the rest aren't hidden silently.
  const approachingTotal = approaching.length;
  const approachingShown = includeApproaching ? approaching.slice(0, limit) : [];

  const holdingRows: HoldingRow[] = [];
  for (const symbol of [...new Set(holdings.lots.map((l) => l.symbol))].sort()) {
    const basis = computeBasis(holdings.lots, symbol);
    if (basis === null) {
      continue;
    }
    const price = quotes.get(symbol)?.lastPrice ?? null;
    holdingRows.push({
      symbol,
      shares: basis.totalCount,
      basis: round(basis.blendedBasis),
      price,
      pctFromBasis: price === null ? null : round(((price - basis.blendedBasis) / basis.blendedBasis) * 100),
      marketValue: price === null ? null : round(price * basis.totalCount),
      lastPurchaseDate: basis.lastPurchaseDate,
      accounts: [...new Set(holdings.lots.filter((l) => l.symbol === symbol && l.account).map((l) => l.account as string))].sort(),
      ignored: isIgnored(symbol),
      stops: holdings.stops.filter((s) => s.symbol === symbol).map((s) => s.stopPrice),
    });
  }

  // Names that have been watched a long time, never fired, and barely moved:
  // each one is an alert slot that could be spent on something else.
  const quietWatches: string[] = [];
  const quietTotal = { count: 0 };
  for (const alert of live) {
    const note = quietWatchNote(
      {
        symbol: alert.symbol,
        watchingSince: alert.watchingSince,
        watchingSinceApprox: alert.watchingSinceApprox,
        observedSince: alert.createdAt,
        priceAtWatchStart: alert.priceAtWatchStart,
        currentPrice: quotes.get(alert.symbol)?.lastPrice ?? null,
        triggerCount: alert.triggerCount,
      },
      now
    );
    if (note !== null) {
      quietTotal.count++;
      if (quietWatches.length < limit) {
        quietWatches.push(note);
      }
    }
  }

  const windowStart = now.getTime() - windowDays * 86_400_000;
  const inWindow = revisits.filter((e) => new Date(e.triggeredAt).getTime() >= windowStart);
  const triggersInWindow = inWindow.length;

  // Capped well above the queue limit: a consumer diffing for new firings
  // only misses one if more than this many fire between two of its polls.
  const alertsById = new Map(alerts.map((a) => [a.id, a]));
  const recentTriggers: TriggerRow[] = revisits
    .filter((e) => !isIgnored(e.symbol))
    .filter((e) => e.status === "open" || new Date(e.triggeredAt).getTime() >= windowStart)
    .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
    .slice(0, RECENT_TRIGGER_CAP)
    .map((e): TriggerRow => {
      const alert = alertsById.get(e.alertId);
      return {
        id: e.id,
        alertId: e.alertId,
        symbol: e.symbol,
        kind: e.kind,
        headline: triggerHeadline(e, narrativeCtx),
        triggeredAt: e.triggeredAt,
        triggerPrice: e.triggerPrice,
        levelAtTrigger: e.levelAtTrigger,
        session: e.session ?? null,
        status: e.status,
        resolvedAt: e.resolvedAt,
        appliedFrom: e.appliedFrom ?? null,
        appliedTo: e.appliedTo ?? null,
        priority: e.priority,
        heldPosition: heldSymbols.has(e.symbol.toUpperCase()),
        chartUrl: chartUrl(e.symbol),
        condition: e.condition ?? (alert ? describeAlertCondition(alert) : null),
        conditionSource: e.condition !== undefined ? "recorded" : alert ? "current" : null,
        alertExists: alert !== undefined,
        volume: e.volume ?? null,
        verdict: e.signals?.verdict ?? null,
        pctMovePastLevel: e.signals?.pctMovePastLevel ?? null,
        volumeRatio: e.signals?.volumeRatio ?? null,
        volumeTrendRatio: e.signals?.volumeTrendRatio ?? null,
        why: e.signals ? explainPriority(e.signals) : null,
        suggestedLevel: e.suggestedLevel,
        suggestionBasis: e.suggestionBasis,
        watchingSince: e.watchingSince ?? null,
        watchingSinceApprox: e.watchingSinceApprox ?? false,
        sinceWatching: sinceWatchingNote(
          e.watchingSince ?? null,
          e.priceAtWatchStart ?? null,
          quotes.get(e.symbol)?.lastPrice ?? e.triggerPrice,
          e.watchingSinceApprox ?? false
        ),
        ma: e.ma ?? null,
        ...crossingDetails(e),
      };
    });

  const stories = buildStories(
    revisits.filter((e) => !isIgnored(e.symbol)),
    narrativeCtx,
    { limit: inputs.storyLimit ?? 5 }
  );

  const tradingViewPrefixes: Record<string, string> = {};
  const shown = [...holdingRows.map((r) => r.symbol), ...stories.map((s) => s.symbol), ...live.map((a) => a.symbol)];
  for (const symbol of [...new Set(shown)].sort()) {
    const prefix = mapExchange(exchanges.get(symbol));
    if (prefix !== null) {
      tradingViewPrefixes[symbol] = prefix;
    }
  }

  return {
    generatedAt: now.toISOString(),
    summary: {
      liveAlerts: live.length,
      symbolsWatched: new Set(live.map((a) => a.symbol)).size,
      openRevisits: open.length,
      actionableRevisits: open.filter((e) => e.suggestedLevel !== null).length,
      triggersInWindow,
      windowDays,
      positions: holdingRows.length,
      quotesUnavailable,
    },
    revisitQueue,
    recentTriggers,
    approaching: approachingShown,
    approachingTotal: includeApproaching ? approachingTotal : 0,
    holdings: holdingRows,
    stories,
    quietWatches,
    quietTotal: quietTotal.count,
    tradingViewPrefixes,
  };
}

/** Terminal rendering of the same document, for when you just want to glance at it. */
export function renderDashboard(d: Dashboard): string {
  const lines: string[] = [];
  const s = d.summary;
  // The machine's local time with its zone named: a bare UTC timestamp read as
  // local time is off by six or seven hours in Mountain time.
  const generated = new Date(d.generatedAt).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  lines.push(`Dashboard — ${generated}`);
  lines.push("=".repeat(72));
  lines.push(
    `${s.liveAlerts} live alert(s) across ${s.symbolsWatched} symbol(s) · ` +
      `${s.openRevisits} open revisit(s) (${s.actionableRevisits} with a proposed level) · ` +
      `${s.triggersInWindow} trigger(s) in ${s.windowDays}d · ${s.positions} position(s)`
  );
  if (s.quotesUnavailable > 0) {
    lines.push(`(${s.quotesUnavailable} alert(s) had no quote available this run)`);
  }

  lines.push("");
  lines.push(`REVISIT QUEUE (${d.revisitQueue.length} shown)`);
  lines.push("-".repeat(72));
  if (d.revisitQueue.length === 0) {
    lines.push("  nothing waiting on a decision");
  }
  for (const r of d.revisitQueue) {
    const pri = r.priority === null ? "  -  " : r.priority.toFixed(1).padStart(5);
    // Narrative first: the number is the sort key, the sentence is the point.
    lines.push(`${pri}  ${r.headline}`);
    lines.push(`         fired ${r.levelAtTrigger ?? "-"} @ ${r.triggerPrice}${r.action ? `. ${r.action}` : ""}`);
    if (r.suggestedLevel !== null) {
      lines.push(`         'alert revisit apply ${r.id}'`);
    }
    if (r.sinceWatching !== null) {
      lines.push(`         ${r.sinceWatching}`);
    }
    if (r.why !== null) {
      lines.push(`         ${r.why}`);
    }
  }

  if (d.stories.length > 0) {
    lines.push("");
    lines.push(`STORIES (${d.stories.length})`);
    lines.push("-".repeat(72));
    for (const s of d.stories) {
      lines.push(`  ${s.summary}`);
      for (const line of s.lines) {
        lines.push(`    ${line.text}`);
      }
      lines.push("");
    }
  }

  if (d.approaching.length > 0) {
    lines.push("");
    const more = d.approachingTotal > d.approaching.length ? ` of ${d.approachingTotal}` : "";
    lines.push(`APPROACHING (nearest ${d.approaching.length}${more} within range)`);
    lines.push("-".repeat(72));
    for (const a of d.approaching) {
      const dist = a.distancePct === null ? "   vol" : `${a.distancePct >= 0 ? "+" : ""}${a.distancePct.toFixed(2)}%`;
      const gate = a.hasVolumeCondition ? " +vol" : "";
    // The arrow carries the side: a below alert needs price to fall to fire,
    // which "90.48 -> 90.40" alone doesn't make obvious.
      const arrow = a.side === "below" ? "\u2193" : a.side === "above" ? "\u2191" : "\u2192";
      lines.push(`${dist.padStart(8)}  ${a.symbol.padEnd(6)} ${a.price} ${arrow} ${a.trigger ?? "-"}${gate}`);
    }
  }

  if (d.quietWatches.length > 0) {
    lines.push("");
    const qMore = d.quietTotal > d.quietWatches.length ? ` of ${d.quietTotal}` : "";
    lines.push(`QUIET (${d.quietWatches.length}${qMore} watched a while, nothing since)`);
    lines.push("-".repeat(72));
    for (const q of d.quietWatches) {
      lines.push(`  ${q}`);
    }
  }

  if (d.holdings.length > 0) {
    lines.push("");
    lines.push(`HOLDINGS (${d.holdings.length})`);
    lines.push("-".repeat(72));
    for (const h of d.holdings) {
      const pct = h.pctFromBasis === null ? "    -" : `${h.pctFromBasis >= 0 ? "+" : ""}${h.pctFromBasis.toFixed(1)}%`;
      const tag = h.ignored ? "  (not alerted)" : "";
      lines.push(`${pct.padStart(8)}  ${h.symbol.padEnd(6)} ${h.shares} @ ${h.basis} → ${h.price ?? "-"}${tag}`);
    }
  }

  return lines.join("\n");
}
