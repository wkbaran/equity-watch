import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDashboard } from "../src/dashboard.js";
import { emptyHoldingsStore } from "../src/holdings/models.js";
import { planSync } from "../src/web/publish.js";
import { SITE_ASSETS, shouldPublish, writeSite } from "../src/web/site.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

describe("shouldPublish", () => {
  const state = { fingerprint: "abc", publishedAt: "2026-09-12T11:50:00.000Z" };

  it("publishes the first time", () => {
    expect(shouldPublish(null, "abc", NOW, 30).publish).toBe(true);
  });

  it("publishes when the fingerprint changed, however recent the last publish", () => {
    expect(shouldPublish(state, "def", NOW, 30)).toEqual({ publish: true, reason: "dashboard changed" });
  });

  it("skips an unchanged dashboard until prices go stale", () => {
    expect(shouldPublish(state, "abc", NOW, 30).publish).toBe(false);
    expect(shouldPublish(state, "abc", NOW, 10).publish).toBe(true);
  });

  // Runs start on a grid but publish seconds in: 11:25:07 is 29.97 min before
  // an 11:55:05 check, and missing it by seconds cost a whole extra interval.
  it("treats a document a few seconds short of the limit as stale", () => {
    const at = { fingerprint: "abc", publishedAt: "2026-09-12T11:30:07.000Z" };
    expect(shouldPublish(at, "abc", new Date("2026-09-12T12:00:05.000Z"), 30).publish).toBe(true);
    expect(shouldPublish(at, "abc", new Date("2026-09-12T11:55:05.000Z"), 30).publish).toBe(false);
  });

  // The window's last run: skipping it would leave the page expecting a check
  // every 15 minutes all night.
  it("publishes when the next check is further off than the page may go stale", () => {
    expect(shouldPublish(state, "abc", NOW, 30, "2026-09-12T19:45:00.000Z")).toEqual({ publish: true, reason: "next check not for 465 min" });
    expect(shouldPublish(state, "abc", NOW, 30, "2026-09-12T12:15:00.000Z").publish).toBe(false);
  });
});

describe("planSync", () => {
  it("uploads new and changed files, deletes remote-only ones", () => {
    const local = new Map([
      ["index.html", "same"],
      ["dashboard.json", "new-md5"],
      ["app.js", "x"],
    ]);
    const remote = new Map([
      ["index.html", "same"],
      ["dashboard.json", "old-md5"],
      ["stale.js", "y"],
    ]);
    expect(planSync(local, remote)).toEqual({
      upload: ["dashboard.json", "app.js"],
      remove: ["stale.js"],
      unchanged: 1,
    });
  });
});

describe("writeSite", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the page assets and the document it polls", () => {
    dir = mkdtempSync(join(tmpdir(), "site-"));
    const d = buildDashboard({ alerts: [], revisits: [], holdings: emptyHoldingsStore(), quotes: new Map(), now: NOW });
    writeSite(dir, d, { holdings: false }, []);
    expect(readdirSync(dir).sort()).toEqual([...SITE_ASSETS, "dashboard.json", "alerts.json"].sort());
    expect(JSON.parse(readFileSync(join(dir, "alerts.json"), "utf-8"))).toEqual({ generatedAt: NOW.toISOString(), alerts: [] });
    const published = JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf-8"));
    expect(published.generatedAt).toBe(NOW.toISOString());
    expect(published.site).toEqual({ holdings: false });
  });
});
