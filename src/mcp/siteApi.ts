/**
 * The dashboard's tool host for Node: a page with no window.
 *
 * web/webmcp.js is written against the `api` app.js builds for the browser
 * (startAgentTools). This builds the same thing from the same sources the page
 * uses - the published dashboard.json, alerts.json and vault.json, and a POST
 * to /api/ops with the ops token - so the MCP server sees what the page sees
 * and changes things the way the page does. It needs nothing from the machine
 * that runs the checks, only the site's address and the token.
 *
 * What differs from the page, and why:
 *   - Access comes from how the server was started, not from buttons: the ops
 *     token (from .env) unlocks writes unless --read-only, and holdings need
 *     --allow-holdings, the headless "Agents may see holdings".
 *   - Pending changes are kept in a file, not localStorage. A stdio client
 *     starts a fresh server per session, and the duplicate guard in queue()
 *     must outlive that.
 *   - Approval is the MCP host's business (src/mcp/server.ts supplies
 *     `confirm`), so SiteApi has none of its own.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorText } from "../errorText.js";
import type { AlertRow } from "../web/alertsPage.js";
import type { SiteDocument } from "../web/site.js";
import { openVault, type VaultContents, type VaultDocument } from "../web/vault.js";
import { formatVolume, parseVolume } from "../volume.js";
import type { PendingOp, ToolApi, ToolText, Toolbox } from "./toolbox.js";

export interface SiteApiOptions {
  /** The published site, e.g. https://watch.example.com (no trailing path). */
  siteUrl: string;
  /** OPS_TOKEN. Without it the server is read-only whatever else is set. */
  token: string | null;
  /** "user:password" for a site behind basic auth (EnableBasicAuth). Reads only: /api/* is outside it. */
  basicAuth?: string | null;
  readOnly: boolean;
  allowHoldings: boolean;
  pendingFile: string;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** How stale dashboard.json may get before a call refetches it. The page polls every minute. */
const REFRESH_MS = 60_000;

export class SiteApi {
  private doc: SiteDocument | null = null;
  private fetchedAt = 0;
  private refreshing: Promise<void> | null = null;
  private vaultData: VaultContents | null = null;
  private vaultProblem: string | null = null;
  private tokenRejected = false;
  private pendingOps: PendingOp[];
  private readonly first: Promise<void>;
  private resolveFirst!: () => void;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly box: Toolbox,
    private readonly opts: SiteApiOptions
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    // stderr only: on stdio, stdout is the protocol.
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.first = new Promise((resolve) => (this.resolveFirst = resolve));
    this.pendingOps = readPending(opts.pendingFile);
  }

  private url(path: string): string {
    return `${this.opts.siteUrl.replace(/\/+$/, "")}/${path}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    // CloudFront serves these with Cache-Control: no-cache; ask the same of anything in between.
    const headers: Record<string, string> = { accept: "application/json", "cache-control": "no-cache" };
    if (this.opts.basicAuth) headers.authorization = `Basic ${Buffer.from(this.opts.basicAuth).toString("base64")}`;
    const resp = await this.fetch(this.url(path), { headers });
    if (resp.status === 401) {
      throw new Error(`${path}: HTTP 401, the site asks for a login; ${this.opts.basicAuth ? "BASIC_AUTH_USER/BASIC_AUTH_PASSWORD were refused" : "set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD"}`);
    }
    if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
    return (await resp.json()) as T;
  }

  /**
   * Refetches the documents when they are older than REFRESH_MS (or always,
   * with `force`), then settles pending changes against what they now say.
   * A failed fetch keeps the last good document and is logged, not thrown: a
   * read should answer from slightly old data rather than not at all.
   */
  async refresh(force = false): Promise<void> {
    if (!force && this.doc && this.now() - this.fetchedAt < REFRESH_MS) return;
    this.refreshing ??= (async () => {
      try {
        this.doc = await this.getJson<SiteDocument>("dashboard.json");
        this.fetchedAt = this.now();
        this.settle();
        await this.refreshVault();
      } catch (err) {
        this.log(`equity-watch mcp: couldn't load ${this.url("dashboard.json")} (${errorText(err)})`);
      } finally {
        this.refreshing = null;
        this.resolveFirst();
      }
    })();
    return this.refreshing;
  }

  private async refreshVault(): Promise<void> {
    if (!this.opts.allowHoldings || !this.opts.token || this.doc?.site?.vault !== true) {
      this.vaultData = null;
      return;
    }
    try {
      this.vaultData = openVault(await this.getJson<VaultDocument>("vault.json"), this.opts.token);
      this.vaultProblem = null;
    } catch (err) {
      this.vaultData = null;
      // An authentication failure means the vault was sealed with a different token.
      this.vaultProblem = /auth|decrypt/i.test(errorText(err)) ? "the ops token doesn't open the holdings vault (it isn't the current token)" : `the holdings vault couldn't be loaded (${errorText(err)})`;
      this.log(`equity-watch mcp: ${this.vaultProblem}`);
    }
  }

  private settle(): void {
    if (this.pendingOps.length === 0 || !this.doc) return;
    const { waiting } = this.box.settlePending(this.pendingOps, this.doc.opResults, this.doc.opsProcessedThrough);
    if (waiting.length !== this.pendingOps.length) {
      this.pendingOps = waiting;
      writePending(this.opts.pendingFile, waiting);
    }
  }

  private editRefusal(): string | null {
    if (this.opts.readOnly) return "This MCP server was started with --read-only, so it offers no tools that change anything. The person has to restart it without that flag.";
    if (!this.opts.token) return "This MCP server has no ops token (OPS_TOKEN in the equity-watch .env), so it can't queue changes.";
    if (this.tokenRejected) return "The site rejected this server's ops token, so it can't queue changes. The person has to fix OPS_TOKEN in the equity-watch .env and restart the server.";
    if (this.doc && this.doc.site?.ops !== true) return "The published dashboard doesn't accept changes (its ops queue is off).";
    return null;
  }

  /** The `api` web/webmcp.js runs against, with the host's own `confirm`. */
  toolApi(confirm: ToolApi["confirm"]): ToolApi {
    // Getters, because the refusal depends on what the site says at the time of the call.
    const refusal = () => this.editRefusal();
    const holdingsRefusal = () => {
      if (!this.opts.allowHoldings) {
        return "Holdings aren't shared with agents by this server. The person has to restart it with --allow-holdings to allow it.";
      }
      return `Holdings aren't available: ${this.vaultProblem ?? "the published site has no holdings vault"}.`;
    };
    const text: ToolText = {
      locked: {
        read: "",
        get write() {
          return refusal() ?? "Editing isn't available.";
        },
        get holdings() {
          return refusal() ?? holdingsRefusal();
        },
      },
      access:
        "Which tools this server offers depends on how the person started it. Tools that add, edit or remove alerts or act on the revisit queue need an ops token and no --read-only flag. " +
        "The person's holdings (positions, share counts, cost basis, stops, and stories of their trades) are private: tools for them appear only when the server is started with --allow-holdings. " +
        "If a tool you need isn't offered, tell the person which of those to do rather than guessing or sending them elsewhere.",
      approved: "The person approved this and it is now queued. It has not taken effect yet.",
    };
    return {
      dashboard: () => this.doc,
      loaded: () => this.first,
      alerts: async () => {
        try {
          return await this.getJson<{ generatedAt?: string; alerts: AlertRow[] }>("alerts.json");
        } catch (err) {
          this.log(`equity-watch mcp: couldn't load alerts.json (${errorText(err)})`);
          return null;
        }
      },
      vault: () => this.vaultData,
      canEdit: () => this.editRefusal() === null && this.doc !== null,
      canEditHoldings: () => this.editRefusal() === null && this.vaultData !== null,
      holdingsShared: () => this.opts.allowHoldings,
      pending: () => this.pendingOps,
      scheduleText: () => this.scheduleText(),
      loginExpiredSince: () => this.doc?.opsAuthExpiredSince ?? null,
      parseVolume,
      formatVolume,
      submit: (op, meta) => this.submit(op, meta),
      confirm,
      text,
    };
  }

  /**
   * The same request app.js's submitOp sends: an id and timestamp made here,
   * the ops token as a bearer, and 202 as the only success.
   */
  private async submit(
    op: Record<string, unknown>,
    meta: { symbol: string | null; alertId: string | null; revisitId: string | null; summary: string }
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const body = { ...op, id: randomUUID(), createdAt: new Date(this.now()).toISOString() };
    let resp: Response;
    try {
      resp = await this.fetch(this.url("api/ops"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: `the request failed (${errorText(err)})` };
    }
    if (resp.status === 401) {
      this.tokenRejected = true;
      return { ok: false, error: "the site rejected the ops token" };
    }
    if (resp.status !== 202) {
      let reason = `HTTP ${resp.status}`;
      try {
        reason = ((await resp.json()) as { error?: string }).error ?? reason;
      } catch {
        /* not JSON */
      }
      return { ok: false, error: reason };
    }
    this.pendingOps = [
      ...this.pendingOps,
      { id: body.id, type: String(op.type), symbol: meta.symbol, alertId: meta.alertId, revisitId: meta.revisitId, summary: meta.summary, queuedAt: body.createdAt },
    ];
    writePending(this.opts.pendingFile, this.pendingOps);
    return { ok: true, id: body.id };
  }

  /**
   * When the next check runs, as far as the published document says. The
   * page's nextCheckText also projects a passed time forward along the
   * cadence; a server that refetches every minute can simply say the cadence.
   */
  private scheduleText(): string | null {
    const d = this.doc;
    if (!d) return null;
    if (d.opsAuthExpiredSince) return "checks paused, the Schwab login expired";
    if (d.opsNextCheckAt && Date.parse(d.opsNextCheckAt) > this.now()) {
      return `next check ${new Date(d.opsNextCheckAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    }
    if (d.opsIntervalMinutes) return `checks run about every ${d.opsIntervalMinutes} min`;
    return null;
  }
}

function readPending(path: string): PendingOp[] {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(v) ? (v as PendingOp[]) : [];
  } catch {
    return [];
  }
}

function writePending(path: string, pending: PendingOp[]): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  // Written aside and renamed, so a crash mid-write can't leave half a file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending, null, 2));
  renameSync(tmp, path);
}
