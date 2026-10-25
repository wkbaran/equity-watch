/**
 * Loads `.env` into process.env, with Node's own loader (process.loadEnvFile,
 * Node 20.12+) instead of the dotenv package.
 *
 * Imported first by cli.ts, for its side effect: ES modules evaluate in import
 * order, so every module after it sees the settings at load time.
 *
 * Same rules as dotenv, checked against this repo's real .env files when it
 * replaced dotenv (2026-10-25): identical parse, and a variable already set in
 * the environment wins over the file. A missing file is fine; the CLI runs
 * without one. A malformed one is not, and throws.
 */

export function loadEnvFile(path: string): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

loadEnvFile(".env");
