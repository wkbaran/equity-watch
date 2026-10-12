import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BETA_SCHEMA,
  buildBetaReport,
  normalizeSymbols,
  parseSymbolsFile,
  runBeta,
  writeFileAtomic,
  type BetaRunDeps,
} from "../src/beta.js";
import { SchwabAuthError, SchwabProvider, type SchwabAuth } from "../src/providers/schwab.js";

const NOW = new Date("2026-10-12T19:30:00.000Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beta-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const table = (betas: Record<string, number | null>) => async (symbol: string) => betas[symbol] ?? null;

/** Captures what the command prints, and where. */
function harness(getBeta: BetaRunDeps["getBeta"]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: BetaRunDeps = { getBeta, now: () => NOW, stdout: (t) => out.push(t), stderr: (l) => err.push(l) };
  return { deps, out, err };
}

describe("symbols", () => {
  it("are uppercased, trimmed and de-duplicated, keeping first-seen order", () => {
    expect(normalizeSymbols([" aapl", "IWM ", "AAPL", "", "  ", "msft"])).toEqual(["AAPL", "IWM", "MSFT"]);
  });

  it("are read from a file, ignoring blank lines and # comments", () => {
    const text = "# watchlist\nAAPL\r\n\n  iwm  # an ETF\n   # indented comment\naapl\n";
    expect(parseSymbolsFile(text)).toEqual(["AAPL", "IWM"]);
  });

  it("pass through unchanged otherwise: a class-share dot or slash is not rewritten", () => {
    expect(normalizeSymbols(["brk.b", "BRK/B"])).toEqual(["BRK.B", "BRK/B"]);
  });
});

describe("buildBetaReport", () => {
  it("has the versioned shape, with generatedAt from the clock", async () => {
    const report = await buildBetaReport(["AAPL"], table({ AAPL: 1.21 }), NOW);
    expect(report).toEqual({
      schema: "equity-watch/betas@1",
      generatedAt: "2026-10-12T19:30:00.000Z",
      source: "schwab instruments fundamental",
      definition: "Beta as computed by Schwab: 5-year monthly, against the market",
      betas: { AAPL: 1.21 },
    });
    expect(report.schema).toBe(BETA_SCHEMA);
  });

  it("keeps a symbol Schwab has no beta for, as null", async () => {
    const report = await buildBetaReport(["AAPL", "IWM"], table({ AAPL: 1.21 }), NOW);
    expect(report.betas).toEqual({ AAPL: 1.21, IWM: null });
    expect("IWM" in report.betas).toBe(true);
  });

  it("asks once per symbol, uppercased", async () => {
    const asked: string[] = [];
    await buildBetaReport(["aapl", "AAPL", " iwm"], async (s) => (asked.push(s), 1), NOW);
    expect(asked).toEqual(["AAPL", "IWM"]);
  });

  it("lets a failure through rather than writing null for what it never reached", async () => {
    const boom = async (s: string) => {
      if (s === "IWM") throw new Error("429");
      return 1;
    };
    await expect(buildBetaReport(["AAPL", "IWM", "XYZ"], boom, NOW)).rejects.toThrow("429");
  });
});

describe("writeFileAtomic", () => {
  it("writes mode 0644 whatever the umask, and leaves no temp file", () => {
    const target = join(dir, "betas.json");
    const before = process.umask(0o077);
    try {
      writeFileAtomic(target, "{}\n");
    } finally {
      process.umask(before);
    }
    expect(readFileSync(target, "utf-8")).toBe("{}\n");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir)).toEqual(["betas.json"]);
  });

  it("replaces an existing file by rename, so the old content is whole until the swap", () => {
    const target = join(dir, "betas.json");
    writeFileSync(target, "old");
    writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf-8")).toBe("new");
  });

  it("leaves no temp file behind when the rename fails after the temp was written", () => {
    // A file can't be renamed over a directory, so this fails at the last step.
    mkdirSync(join(dir, "betas.json"));
    expect(() => writeFileAtomic(join(dir, "betas.json"), "new")).toThrow();
    expect(readdirSync(dir)).toEqual(["betas.json"]);
  });

  it("leaves the existing file alone when the directory is missing", () => {
    const target = join(dir, "betas.json");
    writeFileSync(target, "good");
    expect(() => writeFileAtomic(join(dir, "missing", "betas.json"), "new")).toThrow();
    expect(readFileSync(target, "utf-8")).toBe("good");
    expect(readdirSync(dir)).toEqual(["betas.json"]);
  });
});

describe("runBeta", () => {
  it("prints nothing but the JSON to stdout, and the summary to stderr", async () => {
    const { deps, out, err } = harness(table({ AAPL: 1.21, IWM: null }));
    expect(await runBeta({ symbols: ["aapl", "iwm"] }, deps)).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.betas).toEqual({ AAPL: 1.21, IWM: null });
    expect(out.join("").endsWith("\n")).toBe(true);
    expect(err.join("\n")).toContain("1 of 2 had no beta: IWM");
  });

  it("with --out writes the file, prints nothing to stdout, and still exits 0 with some nulls", async () => {
    const target = join(dir, "betas.json");
    const { deps, out, err } = harness(table({ AAPL: 1.21 }));
    expect(await runBeta({ symbols: ["AAPL", "IWM", "XYZ"], out: target }, deps)).toBe(0);
    expect(out).toEqual([]);
    expect(JSON.parse(readFileSync(target, "utf-8")).betas).toEqual({ AAPL: 1.21, IWM: null, XYZ: null });
    expect(err.join("\n")).toContain("2 of 3 had no beta: IWM, XYZ");
  });

  it("with no symbols exits 1 with a usage message, fetching nothing", async () => {
    const asked: string[] = [];
    const { deps, out, err } = harness(async (s) => (asked.push(s), 1));
    expect(await runBeta({ symbols: [" ", ""] }, deps)).toBe(1);
    expect(asked).toEqual([]);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Usage: equity-watch beta");
  });

  it("writes nothing and exits 1 when every symbol is null, leaving the existing file", async () => {
    const target = join(dir, "betas.json");
    writeFileSync(target, "good");
    const { deps, out } = harness(table({}));
    expect(await runBeta({ symbols: ["AAPL", "IWM"], out: target }, deps)).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe("good");
    expect(out).toEqual([]);
    expect(await runBeta({ symbols: ["AAPL"] }, deps)).toBe(1);
    expect(out).toEqual([]);
  });

  it("exits 3 on an expired login and leaves the existing file", async () => {
    const target = join(dir, "betas.json");
    writeFileSync(target, "good");
    const { deps, out, err } = harness(async () => {
      throw new SchwabAuthError("refresh token expired", { expired: true });
    });
    expect(await runBeta({ symbols: ["AAPL"], out: target }, deps)).toBe(3);
    expect(readFileSync(target, "utf-8")).toBe("good");
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("schwab-login");
  });

  it("exits 1 on any other failure, mid-run, leaving the existing file", async () => {
    const target = join(dir, "betas.json");
    writeFileSync(target, "good");
    const { deps } = harness(async (s) => {
      if (s === "IWM") throw new Error("Schwab beta request for IWM failed (503)");
      return 1;
    });
    expect(await runBeta({ symbols: ["AAPL", "IWM"], out: target }, deps)).toBe(1);
    expect(readFileSync(target, "utf-8")).toBe("good");
    expect(readdirSync(dir)).toEqual(["betas.json"]);
  });

  it("keeps the existing file when the write itself fails", async () => {
    const { deps, err } = harness(table({ AAPL: 1 }));
    expect(await runBeta({ symbols: ["AAPL"], out: join(dir, "missing", "betas.json") }, deps)).toBe(1);
    expect(err.join("\n")).toContain("Could not write");
  });
});

describe("the real command", () => {
  // Run from an empty directory so the repo's .env can't supply credentials,
  // and with an explicit environment. No network: a missing token file is an
  // expired login before any request is made.
  const repo = resolve(import.meta.dirname, "..");
  const tsx = join(repo, "node_modules", ".bin", "tsx");
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(tsx, [join(repo, "src", "cli.ts"), "beta", ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
      encoding: "utf-8",
    });
  const creds = { SCHWAB_APP_KEY: "key", SCHWAB_APP_SECRET: "secret" };

  it("exits 3 with an empty stdout and the file untouched when there is no login", () => {
    const target = join(dir, "betas.json");
    writeFileSync(target, "good");
    const r = run(["AAPL", "--out", target, "--token-path", join(dir, "none.json")], creds);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("schwab-login");
    expect(readFileSync(target, "utf-8")).toBe("good");
    expect(existsSync(join(dir, "none.json"))).toBe(false);
  }, 30_000);

  it("exits 1 with the usual message when Schwab credentials are missing", () => {
    const r = run(["AAPL", "--token-path", join(dir, "none.json")], {});
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Missing Schwab credentials");
  }, 30_000);

  it("exits 1 with a usage message, before it asks about credentials, when given no symbols", () => {
    const file = join(dir, "symbols.txt");
    writeFileSync(file, "# nothing here\n\n");
    const r = run(["--symbols-file", file], {});
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage: equity-watch beta");
  }, 30_000);

  it("exits 1 naming the file when the symbols file can't be read", () => {
    const r = run(["--symbols-file", join(dir, "absent.txt")], creds);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("absent.txt");
  }, 30_000);
});

describe("SchwabProvider.getBetaStrict", () => {
  const provider = new SchwabProvider({ getAccessToken: async () => "token" } as unknown as SchwabAuth, 6000);
  const respond = (status: number, body: unknown = {}) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
  afterEach(() => vi.unstubAllGlobals());

  it("reads the beta, and null when the instrument has none", async () => {
    respond(200, { instruments: [{ fundamental: { beta: 1.21 } }] });
    expect(await provider.getBetaStrict("AAPL")).toBe(1.21);
    respond(200, { instruments: [{ fundamental: {} }] });
    expect(await provider.getBetaStrict("IWM")).toBeNull();
    respond(200, {});
    expect(await provider.getBetaStrict("ZZZZ")).toBeNull();
  });

  it("ignores an instrument that is not the symbol asked for", async () => {
    respond(200, { instruments: [{ symbol: "AAPL", fundamental: { symbol: "AAPL", beta: 1.21 } }] });
    expect(await provider.getBetaStrict("MSFT")).toBeNull();
    // Found wherever it sits in the list, and BRK.B / BRK/B are the same instrument.
    respond(200, {
      instruments: [
        { symbol: "BRKB2", fundamental: { beta: 9 } },
        { symbol: "BRK/B", fundamental: { symbol: "BRK/B", beta: 0.9 } },
      ],
    });
    expect(await provider.getBetaStrict("brk.b")).toBe(0.9);
    // Nothing to compare against: accepted, as before.
    respond(200, { instruments: [{ fundamental: { beta: 1.1 } }] });
    expect(await provider.getBetaStrict("IWM")).toBe(1.1);
  });

  it("treats 404 as no data but throws where the answer says nothing about the symbol", async () => {
    respond(404);
    expect(await provider.getBetaStrict("ZZZZ")).toBeNull();
    for (const status of [401, 403, 429, 500, 503]) {
      respond(status);
      await expect(provider.getBetaStrict("AAPL")).rejects.toThrow(String(status));
    }
  });

  it("leaves getBeta as it was: every non-OK response is null", async () => {
    respond(429);
    expect(await provider.getBeta("AAPL")).toBeNull();
  });
});
