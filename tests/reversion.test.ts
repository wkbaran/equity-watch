import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVERSION_WINDOW_DAYS,
  endedOnFiredSide,
  entryDirection,
  foldLegacyRevisits,
  latestFireOf,
  reversalOf,
  reversionWindowFor,
  tradingDaysAfter,
  watchesDirection,
  withinReversionWindow,
} from "../src/alerts/reversion.js";
import { migrateDirectionStores } from "../src/alerts/revisitStore.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";

// 2026-09-11 is a Friday. 15:00Z is 11:00 Eastern (EDT).
const FRI = "2026-09-11T15:00:00.000Z";

function entry(overrides: Partial<RevisitEntry> = {}): RevisitEntry {
  return {
    id: "e1",
    alertId: "a1",
    symbol: "TEST",
    kind: "static",
    triggeredAt: FRI,
    triggerPrice: 101,
    levelAtTrigger: 100,
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

describe("tradingDaysAfter", () => {
  it("is 0 on the fire's own day and counts a Friday fire as 1 on Monday", () => {
    expect(tradingDaysAfter(new Date(FRI), new Date("2026-09-11T19:59:00.000Z"))).toBe(0);
    expect(tradingDaysAfter(new Date(FRI), new Date("2026-09-12T15:00:00.000Z"))).toBe(0); // Saturday
    expect(tradingDaysAfter(new Date(FRI), new Date("2026-09-14T15:00:00.000Z"))).toBe(1); // Monday
    expect(tradingDaysAfter(new Date(FRI), new Date("2026-09-16T15:00:00.000Z"))).toBe(3); // Wednesday
  });

  it("counts by the Eastern date, not the UTC one", () => {
    // 2026-09-15T02:00Z is Monday 22:00 Eastern: still Monday, though UTC says Tuesday.
    expect(tradingDaysAfter(new Date("2026-09-14T15:00:00.000Z"), new Date("2026-09-15T02:00:00.000Z"))).toBe(0);
    // A Friday post-market fire at 23:30Z (19:30 Eastern) against Sunday 23:00 Eastern,
    // which is Monday 03:00Z: no trading day has passed.
    expect(tradingDaysAfter(new Date("2026-09-11T23:30:00.000Z"), new Date("2026-09-14T03:00:00.000Z"))).toBe(0);
  });
});

describe("reversion helpers", () => {
  it("keeps the window open through day N and closes it after", () => {
    expect(DEFAULT_REVERSION_WINDOW_DAYS).toBe(2);
    expect(withinReversionWindow(FRI, new Date("2026-09-15T19:00:00.000Z"))).toBe(true); // Tuesday = 2
    expect(withinReversionWindow(FRI, new Date("2026-09-16T13:30:00.000Z"))).toBe(false); // Wednesday = 3
    expect(withinReversionWindow(FRI, new Date("2026-09-16T13:30:00.000Z"), 3)).toBe(true);
  });

  it("watches one direction, or both for either", () => {
    expect(watchesDirection("up", "up")).toBe(true);
    expect(watchesDirection("up", "down")).toBe(false);
    expect(watchesDirection("down", "down")).toBe(true);
    expect(watchesDirection("either", "down")).toBe(true);
  });

  it("reads an entry's direction off the record, or derives it for old entries", () => {
    expect(entryDirection(entry({ direction: "down", triggerPrice: 105 }))).toBe("down");
    expect(entryDirection(entry({ triggerPrice: 95 }))).toBe("down");
    expect(entryDirection(entry({ triggerPrice: 101 }))).toBe("up");
    expect(entryDirection(entry({ kind: "volume", levelAtTrigger: null }))).toBeNull();
    // Old trailing entries: levelAtTrigger is `near`, so only the condition tells.
    const trailing = { kind: "trailing" as const, levelAtTrigger: 100, triggerPrice: 90 };
    expect(entryDirection(entry({ ...trailing, condition: "trailing 3% off the low (started near 100)" }))).toBe("up");
    expect(entryDirection(entry({ ...trailing, condition: "trailing $2 off the high (started near 100)" }))).toBe("down");
    expect(entryDirection(entry(trailing))).toBeNull();
    expect(
      entryDirection(entry({ kind: "ma", ma: { maType: "sma", period: 9, timeframe: "1D", event: "touch", approachedFrom: null } }))
    ).toBeNull();
  });

  it("finds the first follow-up against the fire and where price ended up", () => {
    const e = entry({
      direction: "up",
      followUps: [
        { at: "2026-09-11T16:00:00.000Z", price: 99, direction: "down", session: "regular" },
        { at: "2026-09-11T17:00:00.000Z", price: 101, direction: "up", session: "regular" },
        { at: "2026-09-11T18:00:00.000Z", price: 98, direction: "down", session: "regular" },
      ],
    });
    expect(reversalOf(e)?.price).toBe(99);
    expect(endedOnFiredSide(e)).toBe(false);
    expect(reversalOf(entry())).toBeNull();
    expect(endedOnFiredSide(entry())).toBe(true);
  });

  it("finds the latest fire at the alert's current level, ignoring folded entries", () => {
    const old = entry({ id: "old", triggeredAt: "2026-09-01T15:00:00.000Z" });
    const latest = entry({ id: "latest" });
    const folded = entry({ id: "folded", triggeredAt: "2026-09-11T16:00:00.000Z", followUpOf: "latest" });
    const otherLevel = entry({ id: "other", triggeredAt: "2026-09-11T17:00:00.000Z", levelAtTrigger: 110 });
    const otherAlert = entry({ id: "b", alertId: "a2", triggeredAt: "2026-09-11T18:00:00.000Z" });
    expect(latestFireOf([latest, old, folded, otherLevel, otherAlert], "a1", 100)?.id).toBe("latest");
    expect(latestFireOf([latest], "a1", 110)).toBeNull();
  });

  it("takes each symbol's window from its tuned holdDays", () => {
    expect(reversionWindowFor("TEST", null)).toBe(DEFAULT_REVERSION_WINDOW_DAYS);
    const config = { default: { holdDays: 3 }, overrides: { MSFT: { holdDays: 5 } } };
    expect(reversionWindowFor("TEST", config)).toBe(3);
    expect(reversionWindowFor("MSFT", config)).toBe(5);
  });
});

describe("foldLegacyRevisits", () => {
  const NOW = new Date("2026-09-20T12:00:00.000Z");
  const up = () => "up" as const;
  const two = () => 2;

  it("folds chop inside the window onto the fire it follows", () => {
    const fire = entry({ id: "f", triggerPrice: 101 });
    const back = entry({ id: "b", triggeredAt: "2026-09-11T15:30:00.000Z", triggerPrice: 99.5 });
    const again = entry({ id: "c", triggeredAt: "2026-09-14T14:00:00.000Z", triggerPrice: 100.4 });
    const entries = [again, fire, back];

    const result = foldLegacyRevisits(entries, up, two, NOW);

    expect(result).toEqual({ directionsRecorded: 3, folded: 2, dismissed: 0, anchorsWithFollowUps: 1 });
    expect(fire.direction).toBe("up");
    expect(fire.followUps?.map((f) => [f.price, f.direction])).toEqual([
      [99.5, "down"],
      [100.4, "up"],
    ]);
    expect(back.followUpOf).toBe("f");
    expect(again.followUpOf).toBe("f");
    expect(back.status).toBe("open"); // folding hides it; it doesn't resolve it
    expect(reversalOf(fire)?.price).toBe(99.5);
  });

  it("starts a new fire once the window has closed, and dismisses counter-crossings outside any window", () => {
    const early = entry({ id: "early", triggeredAt: "2026-09-08T15:00:00.000Z", triggerPrice: 98 }); // before any fire
    const fire = entry({ id: "f" });
    const lateDown = entry({ id: "down", triggeredAt: "2026-09-16T15:00:00.000Z", triggerPrice: 99 }); // Wed = 3
    const lateUp = entry({ id: "up2", triggeredAt: "2026-09-17T15:00:00.000Z", triggerPrice: 101 });
    const oldDismissed = entry({ id: "old", triggeredAt: "2026-09-07T15:00:00.000Z", triggerPrice: 97, status: "dismissed" });

    const result = foldLegacyRevisits([early, fire, lateDown, lateUp, oldDismissed], up, two, NOW);

    expect(result.folded).toBe(0);
    expect(result.dismissed).toBe(2);
    expect(early).toMatchObject({ status: "dismissed", resolvedAt: NOW.toISOString(), direction: "down" });
    expect(lateDown.status).toBe("dismissed");
    expect(oldDismissed.resolvedAt).toBeNull(); // wasn't open, left alone
    expect(lateUp.followUpOf).toBeUndefined();
    expect(lateUp.status).toBe("open");
  });

  it("uses each symbol's own window", () => {
    const fire = entry({ id: "f" });
    const wed = entry({ id: "w", triggeredAt: "2026-09-16T15:00:00.000Z", triggerPrice: 99 });
    foldLegacyRevisits([fire, wed], up, () => 3, NOW);
    expect(wed.followUpOf).toBe("f");
  });

  it("never folds or dismisses an applied entry, but lets one anchor", () => {
    const appliedFire = entry({ id: "f", status: "applied", resolvedAt: "2026-09-12T00:00:00.000Z" });
    const back = entry({ id: "b", triggeredAt: "2026-09-11T16:00:00.000Z", triggerPrice: 99 });
    const appliedInside = entry({ id: "ai", triggeredAt: "2026-09-11T17:00:00.000Z", triggerPrice: 98, status: "applied" });
    const appliedCounter = entry({ id: "ac", triggeredAt: "2026-09-01T15:00:00.000Z", triggerPrice: 97, status: "applied" });

    foldLegacyRevisits([appliedFire, back, appliedInside, appliedCounter], up, two, NOW);

    expect(back.followUpOf).toBe("f");
    expect(appliedFire.followUps).toHaveLength(1);
    expect(appliedFire).toMatchObject({ status: "applied", resolvedAt: "2026-09-12T00:00:00.000Z" });
    expect(appliedFire.direction).toBeUndefined();
    expect(appliedInside.followUpOf).toBeUndefined();
    expect(appliedInside.direction).toBeUndefined();
    expect(appliedCounter.status).toBe("applied");
  });

  it("does not fold a crossing of a different level onto the fire", () => {
    const fire = entry({ id: "f" });
    const relevelled = entry({ id: "r", triggeredAt: "2026-09-11T18:00:00.000Z", levelAtTrigger: 110, triggerPrice: 111 });
    foldLegacyRevisits([fire, relevelled], up, two, NOW);
    expect(relevelled.followUpOf).toBeUndefined();
    expect(fire.followUps).toBeUndefined();
  });

  it("changes nothing on a second pass", () => {
    const entries = [
      entry({ id: "early", triggeredAt: "2026-09-08T15:00:00.000Z", triggerPrice: 98 }),
      entry({ id: "f" }),
      entry({ id: "b", triggeredAt: "2026-09-11T15:30:00.000Z", triggerPrice: 99.5 }),
      entry({ id: "c", triggeredAt: "2026-09-14T14:00:00.000Z", triggerPrice: 100.4 }),
    ];
    foldLegacyRevisits(entries, up, two, NOW);
    const after = JSON.stringify(entries);
    const second = foldLegacyRevisits(entries, up, two, new Date("2026-09-21T00:00:00.000Z"));
    expect(second).toEqual({ directionsRecorded: 0, folded: 0, dismissed: 0, anchorsWithFollowUps: 0 });
    expect(JSON.stringify(entries)).toBe(after);
  });

  it("leaves non-static entries alone", () => {
    const vol = entry({ id: "v", kind: "volume", levelAtTrigger: null });
    const result = foldLegacyRevisits([vol], up, two, NOW);
    expect(result.directionsRecorded).toBe(0);
    expect(vol.direction).toBeUndefined();
  });
});

describe("migrateDirectionStores", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "equity-watch-migrate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs up both stores, sets every static alert to up, folds the queue, and is idempotent", () => {
    const alertsPath = join(dir, "alerts.json");
    const revisitsPath = join(dir, "revisits.json");
    const base = { symbol: "TEST", status: "live", createdAt: FRI, livePriceAtCreation: 90, side: "above", lastKnownSide: "below" };
    const alerts = [
      { ...base, id: "a1", kind: "static", level: 100 }, // no direction yet
      { ...base, id: "a2", kind: "static", level: 50, direction: "either" },
      { ...base, id: "a3", kind: "static", level: 60, direction: "up" },
      { id: "v1", symbol: "TEST", status: "live", createdAt: FRI, livePriceAtCreation: 90, kind: "volume", volume: { threshold: 1, mode: "today" } },
    ];
    const revisits = [entry({ id: "f" }), entry({ id: "b", triggeredAt: "2026-09-11T16:00:00.000Z", triggerPrice: 99 })];
    writeFileSync(alertsPath, JSON.stringify(alerts));
    writeFileSync(revisitsPath, JSON.stringify(revisits));
    const originalAlerts = readFileSync(alertsPath, "utf-8");

    const first = migrateDirectionStores(alertsPath, revisitsPath, () => 2, new Date("2026-09-20T12:00:00.000Z"));

    expect(first.backups).toHaveLength(2);
    expect(first.backups.every((p) => existsSync(p) && p.includes(join(".cache", "backups")))).toBe(true);
    expect(readFileSync(first.backups[0], "utf-8")).toBe(originalAlerts);
    expect(first).toMatchObject({ staticAlerts: 3, directionsChanged: 2 });
    expect(first.fold).toMatchObject({ folded: 1, anchorsWithFollowUps: 1 });

    const storedAlerts = JSON.parse(readFileSync(alertsPath, "utf-8")) as Record<string, unknown>[];
    expect(storedAlerts.filter((a) => a.kind === "static").every((a) => a.direction === "up")).toBe(true);
    expect(storedAlerts.find((a) => a.kind === "volume")).not.toHaveProperty("direction");
    const storedRevisits = JSON.parse(readFileSync(revisitsPath, "utf-8")) as RevisitEntry[];
    expect(storedRevisits.find((e) => e.id === "b")?.followUpOf).toBe("f");

    const second = migrateDirectionStores(alertsPath, revisitsPath, () => 2, new Date("2026-09-20T13:00:00.000Z"));
    expect(second.directionsChanged).toBe(0);
    expect(second.fold).toEqual({ directionsRecorded: 0, folded: 0, dismissed: 0, anchorsWithFollowUps: 0 });
    expect(readdirSync(join(dir, ".cache", "backups"))).toHaveLength(4);
  });

  it("does not create store files that didn't exist", () => {
    const result = migrateDirectionStores(join(dir, "alerts.json"), join(dir, "revisits.json"), () => 2);
    expect(result.backups).toEqual([]);
    expect(existsSync(join(dir, "alerts.json"))).toBe(false);
    expect(existsSync(join(dir, "revisits.json"))).toBe(false);
  });
});
