/**
 * Writing one of the CSV event logs (breakout reports, alert triggers, holdings
 * alerts). Three writers ended with the same three lines; the columns differ
 * per report, the mechanics don't.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";

/** Writes `rows` to `outPath` with a header, creating the directory if needed. */
export function writeCsv(outPath: string, rows: readonly Record<string, unknown>[], columns: readonly string[]): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stringify(rows as Record<string, unknown>[], { header: true, columns: columns as string[] }));
}
