import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntryPoint } from "../src/entrypoint.js";

describe("isEntryPoint", () => {
  let dir: string;
  let script: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
    mkdirSync(join(dir, "real"));
    script = join(dir, "real", "cli.js");
    writeFileSync(script, "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("matches the module Node was started with", () => {
    // pathToFileURL produces the file:///C:/... form on Windows, which the old
    // string comparison against argv[1] could never equal.
    expect(isEntryPoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it("matches when started through a symlinked directory", () => {
    const link = join(dir, "link");
    // "junction", not "dir": a directory symlink needs admin or Developer Mode on
    // Windows (EPERM otherwise), while a junction doesn't. Elsewhere the type is
    // ignored and this is an ordinary symlink.
    symlinkSync(join(dir, "real"), link, "junction");
    expect(isEntryPoint(pathToFileURL(script).href, join(link, "cli.js"))).toBe(true);
  });

  it("does not match a different script, a missing path, or no argv[1]", () => {
    const other = join(dir, "real", "other.js");
    writeFileSync(other, "");
    expect(isEntryPoint(pathToFileURL(script).href, other)).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, join(dir, "nope.js"))).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, undefined)).toBe(false);
  });
});
