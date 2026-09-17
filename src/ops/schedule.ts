/**
 * How often the ops queue actually gets drained, measured rather than declared.
 *
 * The page can't know when the next `ops pull` will run: the drain happens on
 * the machine that owns the stores, driven by Task Scheduler (or cron), and
 * nothing about that schedule reaches the published site. So `ops pull` keeps
 * a short history of its own clean drains and the publisher ships the observed
 * cadence, which is enough for the page to say "applies in ~9 min" and, when
 * that comes and goes with no drain, to say so instead of waiting silently.
 *
 * The gap is a **median**, never a mean or the latest gap. The schedule has a
 * daily window (the real one runs ~01:55-18:10), so one gap each night is
 * nearly eight hours. A mean or a last-gap reading would take that outlier as
 * the cadence and promise "applies in ~7 hr" all the following day; the median
 * of a dozen drains shrugs it off.
 */

/** What `.cache/ops_pull.json` holds. `recentDrains` is absent in stores written before it existed. */
export interface OpsPullState {
  /**
   * When the last clean drain began. Everything queued before it has been
   * applied, which is what lets the page retire a pending row whose result has
   * already fallen off the end of opResults.
   */
  processedThrough: string;
  /** The starts of recent clean drains, oldest last. Capped at MAX_DRAIN_HISTORY. */
  recentDrains?: string[];
}

/** Twelve drains is eleven gaps: enough that one nightly outlier can't reach the middle. */
export const MAX_DRAIN_HISTORY = 12;

/**
 * Four drains, so the median is a real middle gap rather than the average of
 * two. Below this the cadence is unknown and the page says nothing about it.
 */
const MIN_DRAINS = 4;

export function recordDrain(state: OpsPullState | null, startedAt: string): OpsPullState {
  const history = [...(state?.recentDrains ?? []), startedAt];
  return { processedThrough: startedAt, recentDrains: history.slice(-MAX_DRAIN_HISTORY) };
}

/**
 * The typical minutes between drains, or null when too few have been recorded
 * to say. Rounded, and never below one: a sub-minute cadence would only make
 * the page's countdown flicker.
 */
export function drainIntervalMinutes(state: OpsPullState | null): number | null {
  const drains = state?.recentDrains ?? [];
  if (drains.length < MIN_DRAINS) {
    return null;
  }
  const times = drains.map((d) => new Date(d).getTime());
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    // A clock change or a hand-edited store could make a gap zero or negative.
    if (Number.isFinite(gap) && gap > 0) {
      gaps.push(gap);
    }
  }
  if (gaps.length === 0) {
    return null;
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(median / 60_000));
}
