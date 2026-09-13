/**
 * Whether a module is the script Node was started with.
 *
 * The obvious check, `import.meta.url === \`file://${process.argv[1]}\``,
 * is wrong in two ordinary situations, and wrong silently: the CLI just exits
 * 0 having done nothing.
 *
 *   - Windows: argv[1] is `C:\Users\...\cli.js` and the module URL is
 *     `file:///C:/Users/.../cli.js`. They never match, so under Task Scheduler
 *     every run "succeeds" without checking a single alert.
 *   - Symlinks: run through a symlinked directory, argv[1] keeps the link's
 *     path while import.meta.url resolves to the real file.
 *
 * Comparing the real paths on disk handles both.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
