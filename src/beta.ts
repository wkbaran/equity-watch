/**
 * `equity-watch beta`: hand Schwab's betas to another program as a file.
 *
 * The consumer has no Schwab credentials, reads this on a cron, and decides
 * from `generatedAt` whether the file is too old to use. So the rules here are
 * all about never giving it something worse than what it already has: an atomic
 * write, no replacing good data with nothing, and null (not omission) for a
 * symbol Schwab has no beta for. Docs: docs/BETA.md.
 *
 * Deliberately independent of `.cache/beta/`: that cache never expires, which
 * is right for tuning a breakout check and wrong for a number someone sizes a
 * position by.
 */

import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SchwabAuthError } from "./providers/schwab.js";
import { EXIT_SCHWAB_LOGIN_EXPIRED } from "./providers/authState.js";
import { errorText } from "./errorText.js";

export const BETA_SCHEMA = "equity-watch/betas@1";

export interface BetaReport {
  schema: typeof BETA_SCHEMA;
  generatedAt: string;
  source: string;
  definition: string;
  betas: Record<string, number | null>;
}

/** Uppercased, trimmed, de-duplicated, blanks dropped; first occurrence keeps its place. */
export function normalizeSymbols(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const item of raw) {
    const symbol = item.trim().toUpperCase();
    if (symbol !== "") {
      seen.add(symbol);
    }
  }
  return [...seen];
}

/** One symbol per line; blank lines and `#` comments (whole-line or trailing) are ignored. */
export function parseSymbolsFile(text: string): string[] {
  return normalizeSymbols(text.split(/\r?\n/).map((line) => line.split("#")[0]));
}

/**
 * Fetches each symbol in turn (the provider's rate limiter paces them) and
 * assembles the file. A throw from `getBeta` propagates: a half-fetched report
 * would have to put null against the symbols it never reached, which the
 * consumer would read as "Schwab has no beta".
 */
export async function buildBetaReport(
  symbols: readonly string[],
  getBeta: (symbol: string) => Promise<number | null>,
  now: Date
): Promise<BetaReport> {
  const betas: Record<string, number | null> = {};
  for (const symbol of normalizeSymbols(symbols)) {
    betas[symbol] = await getBeta(symbol);
  }
  return {
    schema: BETA_SCHEMA,
    generatedAt: now.toISOString(),
    source: "schwab instruments fundamental",
    definition: "Beta as computed by Schwab: 5-year monthly, against the market",
    betas,
  };
}

/**
 * Writes beside the target and renames over it, so a reader sees the old file
 * or the new one and never half of either. The temp file is in the same
 * directory because a rename across filesystems is not atomic. Mode is set
 * explicitly (and by chmod, since the umask would otherwise trim it): the file
 * isn't secret and the reader is another user's container.
 */
export function writeFileAtomic(path: string, text: string, mode = 0o644): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export interface BetaRunOptions {
  symbols: readonly string[];
  /** Where to write; without it the JSON goes to `stdout`. */
  out?: string;
}

export interface BetaRunDeps {
  getBeta: (symbol: string) => Promise<number | null>;
  now: () => Date;
  /** The JSON, when there is no `--out`. Nothing else is ever written here. */
  stdout: (text: string) => void;
  /** Progress and summaries. */
  stderr: (line: string) => void;
}

/**
 * The whole command, returning its exit code instead of exiting so the rules
 * can be tested: 0 written, 1 usage/failure/nothing worth writing, 3 login
 * expired (the code the scheduled scripts already branch on).
 */
export async function runBeta(opts: BetaRunOptions, deps: BetaRunDeps): Promise<number> {
  const symbols = normalizeSymbols(opts.symbols);
  if (symbols.length === 0) {
    deps.stderr("No symbols. Usage: equity-watch beta [symbols...] [--symbols-file <path>] [--out <path>]");
    return 1;
  }
  deps.stderr(`Fetching beta for ${symbols.length} symbol${symbols.length === 1 ? "" : "s"}...`);

  let report: BetaReport;
  try {
    report = await buildBetaReport(symbols, deps.getBeta, deps.now());
  } catch (err) {
    if (err instanceof SchwabAuthError && err.expired) {
      deps.stderr(`Schwab login expired: ${err.message}`);
      deps.stderr("Re-authorize with: node dist/cli.js schwab-login");
      return EXIT_SCHWAB_LOGIN_EXPIRED;
    }
    deps.stderr(`Beta fetch failed (${errorText(err)}). Nothing written.`);
    return 1;
  }

  const missing = symbols.filter((symbol) => report.betas[symbol] === null);
  if (missing.length === symbols.length) {
    // All null is what a dead endpoint, a changed response or a transient run
    // of errors looks like, and the consumer keeps the last good file.
    deps.stderr(`No beta came back for any of the ${symbols.length} symbols. Nothing written.`);
    return 1;
  }
  if (missing.length > 0) {
    deps.stderr(`${missing.length} of ${symbols.length} had no beta: ${missing.join(", ")}`);
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.out === undefined) {
    deps.stdout(text);
  } else {
    try {
      writeFileAtomic(opts.out, text);
    } catch (err) {
      deps.stderr(`Could not write ${opts.out} (${errorText(err)}).`);
      return 1;
    }
    deps.stderr(`Wrote ${symbols.length - missing.length} betas to ${opts.out}.`);
  }
  return 0;
}
