import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StaticAlert } from "../src/alerts/models.js";
import { applyQueueRules, DEFAULT_QUEUE_SETTINGS, dismissWithSnooze, queueRank } from "../src/alerts/queueRules.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";
import { latestFireOf } from "../src/alerts/reversion.js";
import { closeRevisitsForSymbol, loadRevisits, saveRevisits } from "../src/alerts/revisitStore.js";
import { parseRevisitDismiss } from "../src/ops/validate.js";

// Wednesday 2026-10-21, 15:00 UTC: mid regular session.
const NOW = new Date("2026-10-21T15:00:00.000Z");
const at = (iso: string) => new Date(iso);

function alert(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    id: "a1",
    symbol: "IBM",
    status: "live",
    createdAt: "2026-09-01T14:00:00.000Z",
    livePriceAtCreation: 90,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-09-01T14:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "static",
    side: "below",
    direction: "up",
    level: 100,
    lastKnownSide: "below",
    ...overrides,
  };
}

function fire(overrides: Partial<RevisitEntry> = {}): RevisitEntry {
  return {
    id: "f1",
    alertId: "a1",
    symbol: "IBM",
    kind: "static",
    triggeredAt: "2026-10-20T15:00:00.000Z",
    triggerPrice: 100.5,
    levelAtTrigger: 100,
    direction: "up",
    session: "regular",
    watchingSince: null,
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    status: "open",
    appliedFrom: null,
    appliedTo: null,
    suggestedLevel: null,
    suggestedAt: null,
    suggestionBasis: null,
    resolvedAt: null,
    priority: null,
    signals: null,
    ...overrides,
  };
}

const prices = (price: number) => new Map([["IBM", price]]);
// An alert that fired recently, so it is not a drift candidate; the rules under test are about the fire.
const recentlyFired = () => alert({ lastTriggeredAt: "2026-10-20T15:00:00.000Z" });

describe("applyQueueRules", () => {
  it("judges nothing without regular-session prices", () => {
    const entries = [fire()];
    const result = applyQueueRules(entries, [alert({ createdAt: "2026-01-01T00:00:00.000Z" })], new Map(), NOW);
    expect(result).toEqual({ created: [], changed: [], lines: [] });
  });

  describe("(a) accelerating", () => {
    it("marks a fire that ran 2% past its level within 2 trading days, once", () => {
      const entries = [fire()];
      applyQueueRules(entries, [recentlyFired()], prices(102.1), NOW);
      expect(entries[0].accelerated).toEqual({ at: NOW.toISOString(), price: 102.1, pct: 2.1 });
      const again = applyQueueRules(entries, [recentlyFired()], prices(105), NOW);
      expect(again.changed).toEqual([]);
      expect(entries[0].accelerated?.price).toBe(102.1);
    });

    it("reads a downward fire downward", () => {
      const entries = [fire({ direction: "down", triggerPrice: 99.5 })];
      applyQueueRules(entries, [recentlyFired()], prices(97.9), NOW);
      expect(entries[0].accelerated?.pct).toBe(2.1);
    });

    it("leaves a slow one or a late one alone", () => {
      const slow = [fire()];
      applyQueueRules(slow, [recentlyFired()], prices(101.9), NOW);
      expect(slow[0].accelerated).toBeUndefined();
      // Fired Thursday 10-15: Wednesday 10-21 is 4 trading days on.
      const late = [fire({ triggeredAt: "2026-10-15T15:00:00.000Z" })];
      applyQueueRules(late, [recentlyFired()], prices(110), NOW);
      expect(late[0].accelerated).toBeUndefined();
    });
  });

  describe("(b) dismissed, then kept going", () => {
    const dismissedOn = at("2026-10-09T15:00:00.000Z"); // a Friday

    function dismissed(days = 7) {
      const e = fire({ triggeredAt: "2026-10-08T15:00:00.000Z" });
      dismissWithSnooze(e, days, DEFAULT_QUEUE_SETTINGS, dismissedOn);
      return e;
    }

    it("records the price it was dismissed at on the next check, then waits", () => {
      const entries = [dismissed()];
      applyQueueRules(entries, [recentlyFired()], prices(103), at("2026-10-09T16:00:00.000Z"));
      expect(entries[0].dismissedPrice).toBe(103);
      // 10-16 is 5 trading days on: still waiting, however far it has gone.
      applyQueueRules(entries, [recentlyFired()], prices(120), at("2026-10-16T15:00:00.000Z"));
      expect(entries[0].status).toBe("dismissed");
    });

    it("reopens after the wait if price kept going past where it was dismissed", () => {
      const entries = [dismissed()];
      applyQueueRules(entries, [recentlyFired()], prices(103), at("2026-10-09T16:00:00.000Z"));
      // 10-20 is 7 trading days on.
      const result = applyQueueRules(entries, [recentlyFired()], prices(104), at("2026-10-20T15:00:00.000Z"));
      expect(result.changed).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        status: "open",
        resolvedAt: null,
        reminder: { at: "2026-10-20T15:00:00.000Z", price: 104, dismissedAt: dismissedOn.toISOString(), dismissedPrice: 103 },
      });
      expect(entries[0].snoozeDays).toBeUndefined();
      expect(queueRank(entries[0], false, NOW).reason).toBe("reminder");
    });

    it("stays dismissed if it didn't keep going, the alert moved, a newer fire came, or a change settled it", () => {
      const later = at("2026-10-21T15:00:00.000Z");
      const cases: [RevisitEntry[], StaticAlert[], number][] = [
        [[dismissed()], [recentlyFired()], 102],
        [[dismissed()], [alert({ level: 105, lastTriggeredAt: "2026-10-20T15:00:00.000Z" })], 110],
        [[dismissed(), fire({ id: "f2", triggeredAt: "2026-10-19T15:00:00.000Z", status: "applied", resolvedAt: "2026-10-19T16:00:00.000Z" })], [recentlyFired()], 110],
        [[{ ...dismissed(), snoozeDays: null }], [recentlyFired()], 110],
        // A crossing the alert doesn't watch (an old counter-direction fire).
        [[{ ...dismissed(), direction: "down" as const, triggerPrice: 99.5 }], [recentlyFired()], 90],
      ];
      for (const [entries, alerts, price] of cases) {
        entries[0].dismissedPrice = 103;
        applyQueueRules(entries, alerts, prices(price), later);
        expect(entries[0].status).toBe("dismissed");
      }
    });

    it("brings back a dismissal made before waits existed, after the default wait, measured from the fire", () => {
      const legacy = fire({ triggeredAt: "2026-09-01T15:00:00.000Z", triggerPrice: 101, status: "dismissed", resolvedAt: "2026-09-02T15:00:00.000Z" });
      const below = [{ ...legacy }];
      applyQueueRules(below, [recentlyFired()], prices(100.8), NOW);
      expect(below[0].status).toBe("dismissed");
      expect(below[0].dismissedPrice).toBeUndefined();
      const past = [{ ...legacy }];
      applyQueueRules(past, [recentlyFired()], prices(130), NOW);
      expect(past[0]).toMatchObject({ status: "open", reminder: { dismissedAt: "2026-09-02T15:00:00.000Z", dismissedPrice: null } });
      // Dismissing it again rearms it: a wait, from now.
      dismissWithSnooze(past[0], undefined, DEFAULT_QUEUE_SETTINGS, NOW);
      expect(past[0]).toMatchObject({ status: "dismissed", snoozeDays: 7, resolvedAt: NOW.toISOString() });
    });

    it("a change to the symbol settles a waiting dismissal for good", () => {
      const path = join(mkdtempSync(join(tmpdir(), "queue-")), "revisits.json");
      const legacy = fire({ id: "old", status: "dismissed", resolvedAt: "2026-09-02T15:00:00.000Z" });
      saveRevisits(path, [dismissed(), legacy]);
      closeRevisitsForSymbol(path, "IBM", { change: "lot.add" });
      expect(loadRevisits(path).map((e) => e.snoozeDays)).toEqual([null, null]);
    });
  });

  describe("(c) drifted", () => {
    // Created 09-01, never fired: 50 days quiet by 10-21.
    it("raises an entry for an alert quiet 21 days and 6% the wrong side", () => {
      const entries: RevisitEntry[] = [];
      const result = applyQueueRules(entries, [alert()], prices(93.9), NOW);
      expect(result.created).toHaveLength(1);
      expect(result.created[0]).toMatchObject({
        reason: "drift",
        alertId: "a1",
        levelAtTrigger: 100,
        triggerPrice: 93.9,
        direction: "up",
        status: "open",
        drift: { pct: 6.1, quietSince: "2026-09-01T14:00:00.000Z" },
      });
      // And not again while that one speaks for it, open or dismissed.
      entries.push(...result.created);
      expect(applyQueueRules(entries, [alert()], prices(80), NOW).created).toEqual([]);
      dismissWithSnooze(entries[0], 30, DEFAULT_QUEUE_SETTINGS, NOW);
      expect(applyQueueRules(entries, [alert()], prices(80), NOW).created).toEqual([]);
    });

    it("reads a down alert the other way, and skips either-way alerts", () => {
      expect(applyQueueRules([], [alert({ direction: "down" })], prices(106.5), NOW).created).toHaveLength(1);
      expect(applyQueueRules([], [alert({ direction: "down" })], prices(93), NOW).created).toEqual([]);
      expect(applyQueueRules([], [alert({ direction: "either" })], prices(80), NOW).created).toEqual([]);
    });

    it("waits out 21 days from the last fire or the last change to the symbol", () => {
      expect(applyQueueRules([], [alert({ lastTriggeredAt: "2026-10-05T15:00:00.000Z" })], prices(90), NOW).created).toEqual([]);
      expect(applyQueueRules([], [alert()], prices(94.5), NOW).created).toEqual([]);
      const acted = fire({ triggeredAt: "2026-09-02T15:00:00.000Z", status: "applied", resolvedAt: "2026-10-10T15:00:00.000Z" });
      expect(applyQueueRules([acted], [alert()], prices(90), NOW).created).toEqual([]);
    });

    it("is closed by a fire, and is never a fire itself", () => {
      const entries: RevisitEntry[] = [];
      entries.push(...applyQueueRules(entries, [alert()], prices(90), at("2026-10-01T15:00:00.000Z")).created);
      expect(latestFireOf(entries, "a1", 100)).toBeNull();
      entries.push(fire({ triggeredAt: "2026-10-20T15:00:00.000Z" }));
      applyQueueRules(entries, [recentlyFired()], prices(100.5), NOW);
      expect(entries[0]).toMatchObject({ status: "dismissed", snoozeDays: null });
    });

    it("a dismissed drift comes back after its wait if it is still drifted", () => {
      const entries = applyQueueRules([], [alert()], prices(90), at("2026-10-01T15:00:00.000Z")).created;
      dismissWithSnooze(entries[0], 7, DEFAULT_QUEUE_SETTINGS, at("2026-10-01T16:00:00.000Z"));
      applyQueueRules(entries, [alert()], prices(90), NOW);
      expect(entries[0].status).toBe("open");
      expect(queueRank(entries[0], false, NOW).reason).toBe("drift");
    });
  });
});

describe("queueRank", () => {
  it("adds a held position to any reason", () => {
    expect(queueRank(fire(), false, NOW).priority).toBe(60);
    expect(queueRank(fire(), true, NOW)).toMatchObject({ priority: 70, why: "New fire; held position." });
  });
});

describe("parseRevisitDismiss", () => {
  it("takes whole trading days from 1, and nothing for the default; there is no never", () => {
    expect(parseRevisitDismiss({})).toEqual({ ok: true, value: {} });
    expect(parseRevisitDismiss({ days: 14 })).toEqual({ ok: true, value: { days: 14 } });
    expect(parseRevisitDismiss({ days: 0 }).ok).toBe(false);
    expect(parseRevisitDismiss({ days: 7.5 }).ok).toBe(false);
    expect(parseRevisitDismiss({ days: 91 }).ok).toBe(false);
    expect(parseRevisitDismiss({ until: 3 }).ok).toBe(false);
  });
});
