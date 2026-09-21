import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OP_TYPES } from "../src/ops/apply.js";

/**
 * The API Lambda's handler is inline in cloudformation.yaml — it can't import
 * from src/, so its list of op types is a second copy of OP_TYPES. When they
 * drift, the page gets "Unknown op type" for an op the worker handles perfectly
 * well, and only after a stack deploy.
 *
 * Nothing caught that before: the e2e suite fakes the Lambda
 * (playwright/server.ts) and its fake falls through to a generic success, so a
 * new op type missing from the template passes every test and fails only in
 * production. This is the same trick tests/volume.test.ts uses on web/app.js —
 * read the other copy and compare.
 */
describe("the inline Lambda's op contract", () => {
  const template = readFileSync(new URL("../cloudformation.yaml", import.meta.url), "utf-8");

  it("dispatches exactly the op types the worker applies", () => {
    const literal = /const TARGET_KEY = \{([\s\S]*?)\};/.exec(template);
    expect(literal, "TARGET_KEY moved or changed shape in cloudformation.yaml").not.toBeNull();
    const keys = [...literal![1].matchAll(/"([a-z]+\.[a-z]+)"\s*:/g)].map((m) => m[1]);
    expect([...keys].sort()).toEqual([...OP_TYPES].sort());
  });

  it("names a target key only for ops that have one", () => {
    // A null here means "no target required"; a string is the field the
    // Lambda insists on before queueing. Guards the shape the first test
    // relies on, so a rewrite of the literal can't silently pass it.
    const literal = /const TARGET_KEY = \{([\s\S]*?)\};/.exec(template)![1];
    const entries = [...literal.matchAll(/"([a-z]+\.[a-z]+)"\s*:\s*(null|"[a-zA-Z]+")/g)];
    expect(entries).toHaveLength(OP_TYPES.length);
    const byType = Object.fromEntries(entries.map((m) => [m[1], m[2] === "null" ? null : m[2].slice(1, -1)]));
    // An edit or a remove must be aimed by id, never by ticker: that is the
    // rule applyEdit/applyRemove enforce on the other side.
    expect(byType["alert.edit"]).toBe("alertId");
    expect(byType["alert.remove"]).toBe("alertId");
    expect(byType["revisit.dismiss"]).toBe("revisitId");
    // Adds carry everything in params, so they need no target.
    expect(byType["alert.add"]).toBeNull();
    expect(byType["lot.add"]).toBeNull();
    expect(byType["stop.add"]).toBeNull();
  });
});
