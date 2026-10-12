import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The betas job's wiring is spread over four files that nothing else ties
 * together: a compose mount, a script, a crontab line and a Dockerfile COPY.
 * Each can be dropped or "tidied" with every other test still green, and the
 * job then fails only on nuc1, at 08:05.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

describe("compose", () => {
  const compose = read("docker/docker-compose.yaml");
  const block = (service: string) => {
    const start = compose.indexOf(`\n  ${service}:\n`);
    expect(start, `service ${service}`).toBeGreaterThan(-1);
    const next = compose.slice(start + 1).search(/\n {2}[a-z-]+:\n|\nnetworks:/);
    return compose.slice(start, next === -1 ? undefined : start + 1 + next);
  };

  it("requires SHARED_DIR and mounts it at /shared with :z, never :Z", () => {
    expect(compose).toMatch(/&shared-volume "\$\{SHARED_DIR:\?[^}]+\}:\/shared:z"/);
    expect(code(compose)).not.toMatch(/:Z\b/);
  });

  it("gives equity-watch and cli both mounts, and mcp neither the shared one", () => {
    for (const service of ["equity-watch", "cli"]) {
      expect(block(service)).toContain("volumes: [*state-volume, *shared-volume]");
    }
    expect(block("mcp")).not.toContain("shared-volume");
  });

  it("mounts the directory, not a file", () => {
    expect(code(compose)).not.toMatch(/SHARED_DIR[^"]*betas\.json/);
  });
});

describe("the schedule", () => {
  it("runs the betas job weekdays at 08:05 and 14:05, beside the 15-minute check", () => {
    const lines = code(read("docker/crontab")).split("\n").filter((l) => l.trim() !== "");
    expect(lines).toEqual(["*/15 * * * * /app/docker/run-check.sh", "5 8,14 * * 1-5  /app/docker/run-beta.sh"]);
  });

  it("is copied into the image with the other scripts", () => {
    expect(read("docker/Dockerfile")).toMatch(/COPY docker\/[^\n]*run-beta\.sh[^\n]* \.\/docker\//);
  });
});

describe("docker/run-beta.sh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-beta-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the script with a stand-in `equity-watch` that records how it was called. */
  function run(exitCode: number) {
    const stub = join(dir, "equity-watch");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${dir}/args"\necho "$SCHWAB_MAX_REQUESTS_PER_MINUTE" > "${dir}/rate"\nexit ${exitCode}\n`);
    chmodSync(stub, 0o755);
    const r = spawnSync("bash", [join(import.meta.dirname, "..", "docker", "run-beta.sh")], {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, EQUITY_WATCH_STATE_DIR: dir, SCHWAB_MAX_REQUESTS_PER_MINUTE: "100" },
      encoding: "utf-8",
    });
    return { ...r, args: readFileSync(join(dir, "args"), "utf-8").trim(), rate: readFileSync(join(dir, "rate"), "utf-8").trim() };
  }

  it("runs the beta command on the shared files at 30 requests a minute", () => {
    const r = run(0);
    expect(r.status).toBe(0);
    expect(r.args).toBe("beta --symbols-file /shared/underlyings.txt --out /shared/betas.json");
    expect(r.rate).toBe("30");
  });

  it("logs a lapsed login as keeping the old betas, and exits with the command's code", () => {
    const r = run(3);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("login expired, keeping the old betas");
  });

  it("passes any other failure's code through", () => {
    const r = run(1);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("exited 1");
  });

  it("leaves the check's heartbeat and ping alone", () => {
    const script = code(read("docker/run-beta.sh"));
    expect(script).not.toContain("last-run");
    expect(script).not.toContain("HEALTHCHECK_URL");
    expect(script).not.toContain("curl");
  });
});
