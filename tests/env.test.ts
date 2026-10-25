import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/env.js";

/** Node's process.loadEnvFile replaced dotenv; these are the dotenv rules the CLI relied on. */
describe("loadEnvFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-"));
  afterEach(() => {
    delete process.env.EW_ENV_TEST_A;
    delete process.env.EW_ENV_TEST_B;
  });

  it("fills unset variables, and never overrides one already set", () => {
    const file = join(dir, ".env");
    writeFileSync(file, 'EW_ENV_TEST_A=from-file\nEW_ENV_TEST_B="quoted value" # a comment\n');
    process.env.EW_ENV_TEST_A = "from-env";
    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.EW_ENV_TEST_A).toBe("from-env");
    expect(process.env.EW_ENV_TEST_B).toBe("quoted value");
  });

  it("is fine with no file", () => {
    expect(loadEnvFile(join(dir, "missing.env"))).toBe(false);
  });
});
