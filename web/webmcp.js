// WebMCP adapter: hands a browser-side agent the dashboard's own controls as tools.
//
// A proof of concept for https://github.com/webmachinelearning/webmcp, and a
// deliberately thin one. Nothing here is a second path to the data or a second
// way to change it:
//
//   reads   come from the documents app.js already holds (dashboard.json,
//           alerts.json, and the decrypted vault once editing is unlocked).
//   writes  go through app.js's submitOp, so they are queued to /api/ops with
//           the same ops token, the same `expect` guards and the same worker-side
//           validation as a click. A tool can do nothing the unlocked page can't.
//
// What the spec does NOT give us, and this file supplies:
//
//   * Consent. The spec's user-confirmation story is an open issue (#165), so
//     every write tool shows the page's own confirm dialog and waits for a real
//     click before anything is queued.
//   * A privacy line. Holdings size and value never leave the browser today.
//     Handing them to a tool hands them to whatever model the agent runs on, so
//     the holdings tools stay unregistered until the person turns them on.
//
// The host object has moved once already (navigator.modelContext ->
// document.modelContext), and the registration call with it. Detect both, and
// keep everything version-specific in host()/add()/drop() below.
//
// Two hosts share this file. The page loads it before app.js as a classic
// script and registers the tools with the browser (start()). The MCP server
// (src/mcp/) imports it in Node and serves the same tools over MCP, calling
// callTool() exactly as the page does. So the core - TOOLS, checkArgs, queue,
// callTool, settlePending - must not touch the DOM, and wording that names how
// a person grants access goes through `api.text` (see PAGE_TEXT). It exports
// through one global, which is also how tests/webmcp.test.ts evaluates it.

(function (root) {
  "use strict";

  // ---- results ---------------------------------------------------------------

  const say = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
  const refuse = (message) => ({ content: [{ type: "text", text: message }], isError: true });

  // ---- the confirm dialog ------------------------------------------------------

  let confirmChain = Promise.resolve();

  /**
   * How long a question waits for an answer before it is declined.
   *
   * Not a courtesy: the page can't tell when an agent gives up on a call.
   * Chrome 152 calls execute() with the input alone - no AbortSignal - and when
   * the agent cancels (CDP WebMCP.cancelInvocation) it tells the agent
   * "Canceled" at once while the page carries on. Verified 2026-09-30: the
   * dialog stayed up, and approving it queued a change the agent had been
   * told didn't happen. The expiry bounds that window; the identical-change
   * check in queue() catches the retry that usually follows. A property on the
   * export so tests can shorten it.
   */
  const CONFIRM_TIMEOUT_MS = 120_000;

  /**
   * Asks the person, on the page, before an agent's change is queued. Requests
   * are shown one at a time: two modals at once would let the second hide what
   * the first was asking.
   *
   * Resolves "approved" only for a trusted click on the confirm button. A
   * synthetic `element.click()` from script has `isTrusted === false` and is
   * ignored, so page-injected JavaScript can't approve its own request. An
   * agent driving the browser through real input events still can; that is a
   * property of the agent, and docs/DASHBOARD.md says so. Otherwise
   * "declined", "expired", or "cancelled" (a signal, where a browser passes one).
   */
  function confirmChange(summary, signal) {
    const run = confirmChain.then(() => showConfirm(summary, signal));
    confirmChain = run.catch(() => {});
    return run;
  }

  function showConfirm(summary, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve("cancelled");
      const limitMs = root.equityWatchWebMcp?.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = `Queued, not applied: it lands at the next scheduled check, and is rejected then if the thing has changed since. Declined automatically if not answered within ${Math.round(limitMs / 60_000) || 1} min.`;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Decline";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "primary";
      accept.textContent = "Queue this change";
      const title = document.createElement("strong");
      title.textContent = "An agent wants to queue a change";
      const what = document.createElement("p");
      what.className = "agent-what";
      what.textContent = summary;
      const buttons = document.createElement("div");
      buttons.className = "agent-buttons";
      buttons.append(cancel, accept);
      const dialog = document.createElement("dialog");
      dialog.className = "agent-confirm";
      dialog.setAttribute("aria-label", "Agent change request");
      dialog.append(title, what, note, buttons);

      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(answer);
      };
      const timer = setTimeout(() => finish("expired"), limitMs);
      const onAbort = () => finish("cancelled");
      signal?.addEventListener("abort", onAbort);
      // Escape is answered here; the page's own Escape handler would close the drawer behind it too.
      dialog.addEventListener("keydown", (e) => e.stopPropagation());
      // Escape closes a modal dialog without a click on either button.
      dialog.addEventListener("close", () => finish("declined"));
      cancel.addEventListener("click", () => finish("declined"));
      accept.addEventListener("click", (e) => {
        if (!e.isTrusted) {
          note.textContent = "Ignored: this needs a real click, not a scripted one.";
          return;
        }
        finish("approved");
      });
      document.body.append(dialog);
      dialog.showModal();
      cancel.focus();
    });
  }

  const NOT_APPROVED = {
    declined: "The person declined this change. Nothing was queued.",
    expired: "The person didn't answer within the time allowed, so the change was declined. Nothing was queued; ask again if it is still wanted.",
    cancelled: "The call was cancelled before the person answered. Nothing was queued.",
  };

  // ---- shared pieces ---------------------------------------------------------

  const AVAILABLE = {
    read: () => true,
    write: (api) => api.canEdit(),
    // Holdings come out of the encrypted vault and are private, so they need the
    // vault open AND the person's own say-so to share them with an agent.
    holdings: (api) => api.canEditHoldings() && api.holdingsShared(),
  };

  // ---- wording that depends on the host ------------------------------------------
  //
  // This file serves two hosts: the page (WebMCP) and the Node MCP server
  // (src/mcp/), which imports it. Everything else here is the same for both;
  // these are the few sentences that name how a person grants access or
  // approves a change, which differ. A host overrides them with `api.text`.

  const PAGE_TEXT = {
    locked: {
      read: "",
      write: "Editing is locked. The person has to unlock editing on the dashboard first.",
      holdings: "Holdings aren't shared with agents. The person has to unlock editing and turn on 'Agents may see holdings' on the dashboard.",
    },
    access:
      "Which tools this page offers depends on what the person has allowed. Tools that add, edit or remove alerts or act on the revisit queue appear only once the person clicks 'Unlock editing' on the page. " +
      "The person's holdings (positions, share counts, cost basis, stops, and stories of their trades) are private: tools for them appear only when editing is unlocked and the person ticks 'Agents may see holdings'. " +
      "If a tool you need isn't offered, tell the person which of those to do rather than guessing or sending them elsewhere.",
    approved: "The person approved this on the page and it is now queued. It has not taken effect yet.",
    autoApproved:
      "Queued without asking: the person has turned off confirmation of agent changes on this page. It has not taken effect yet; tell them what you queued.",
  };

  const lockedMessage = (api, group) => api.text?.locked?.[group] ?? PAGE_TEXT.locked[group];

  /** A tool's description as this host tells it: get_overview's access paragraph is host wording. */
  const descriptionFor = (tool, api) => (tool.accessNote ? `${tool.description} ${api.text?.access ?? PAGE_TEXT.access}` : tool.description);

  /**
   * MCP tool annotations, derived from what a tool queues. Chrome reads
   * `readOnlyHint` (it reports `readOnly`); MCP clients use the rest to decide
   * what to ask the person before a call.
   */
  function annotationsFor(tool) {
    if (tool.ops === undefined) return { readOnlyHint: true, openWorldHint: false };
    return {
      readOnlyHint: false,
      destructiveHint: tool.ops.some((op) => op.endsWith(".remove") || op === "revisit.dismiss"),
      idempotentHint: false,
      openWorldHint: false,
    };
  }

  /** Summaries of changes asked about or being sent right now; see queue(). */
  const inFlight = new Set();

  /** Queue an op after the person has agreed to it; the shared tail of every write tool. */
  async function queue(api, group, signal, { op, symbol, alertId = null, revisitId = null, summary }) {
    if (!AVAILABLE[group](api)) return refuse(lockedMessage(api, group));
    // An agent that retries - after a timeout, or a cancel the page never heard
    // about (see CONFIRM_TIMEOUT_MS) - must not queue the same change twice. A
    // second identical lot.add would double a position.
    const same = api.pending().find((p) => p.summary === summary);
    if (same) {
      return refuse(`That exact change is already queued (op ${same.id}, queued ${same.queuedAt}). It hasn't been applied yet; call get_pending_changes for its outcome rather than queueing it again.`);
    }
    // The pending list only learns of a change once its POST returns, so one
    // still being asked about or sent is tracked here: a retry landing in that
    // gap otherwise got a second dialog of its own.
    if (inFlight.has(summary)) {
      return refuse("That exact change is already waiting on the person or being queued. Don't send it again; call get_pending_changes shortly for its outcome.");
    }
    inFlight.add(summary);
    let result;
    let approvalStatus;
    try {
      // The page asks with its dialog; another host (the MCP server) brings its own way of asking.
      // A confirm answers "approved" | "declined" | "expired" | "cancelled", or
      // { answer, status } when it has something to say about how approval was given.
      // Unless the person switched asking off on the page ("Queue agent changes
      // without asking"). Only a host offering that switch sets autoApprove, and
      // every other guard here - arguments, duplicates, the lock - still applies.
      const asked = api.autoApprove?.()
        ? { answer: "approved", status: api.text?.autoApproved ?? PAGE_TEXT.autoApproved }
        : await (api.confirm ?? confirmChange)(summary, signal);
      const answer = typeof asked === "string" ? asked : asked.answer;
      if (answer !== "approved") return refuse(NOT_APPROVED[answer]);
      approvalStatus = typeof asked === "string" ? null : (asked.status ?? null);
      // Locking, or turning holdings off, while the dialog was open withdraws the permission.
      if (!AVAILABLE[group](api)) return refuse(lockedMessage(api, group));
      result = await api.submit(op, { symbol, alertId, revisitId, summary });
    } finally {
      inFlight.delete(summary);
    }
    if (!result.ok) return refuse(`Couldn't queue that: ${result.error}`);
    return say({
      queued: true,
      // Models read "applies at the next check" as "done", or as still awaiting the person's OK. It is neither.
      applied: false,
      status: approvalStatus ?? api.text?.approved ?? PAGE_TEXT.approved,
      opId: result.id,
      change: summary,
      applies: api.scheduleText() ?? "at the next scheduled check",
      next: "Nothing has changed yet. Call get_pending_changes to see when the worker has applied or rejected it.",
    });
  }

  /**
   * Checks a call against the tool's own inputSchema, and returns the args to
   * run with or the reason they were refused.
   *
   * The browser does not do this. Verified against Chrome 152 with WebMCP on
   * (2026-09-30): a wrong type, an unknown key and a missing required field all
   * reach execute() untouched, so a schema is advice to the agent and nothing
   * more. Only the subset of JSON Schema the tools use is understood: type
   * (one or a list), enum, minimum/maximum, required, and
   * additionalProperties: false.
   *
   * Unknown keys are refused, as the worker refuses them: a dropped field
   * would apply a different change than the one asked for. The one leniency
   * is a number sent as a numeric string ("200"), which models do often and
   * which the worker would have accepted anyway; it is converted, not refused.
   */
  function checkArgs(schema, raw) {
    const args = raw === undefined || raw === null ? {} : raw;
    if (typeof args !== "object" || Array.isArray(args)) return { error: "Arguments must be a JSON object." };
    const props = schema.properties;
    const known = Object.keys(props);
    const extra = Object.keys(args).filter((k) => !known.includes(k));
    if (extra.length > 0) {
      return { error: `Unknown field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}. ${known.length ? `Accepted: ${known.join(", ")}.` : "This tool takes no arguments."}` };
    }
    const out = {};
    const problems = [];
    for (const [key, value] of Object.entries(args)) {
      // An absent value, however the agent spelled it, is the same as leaving the key out.
      if (value === null || value === undefined) continue;
      const spec = props[key];
      const types = spec.type === undefined ? [] : [].concat(spec.type);
      let v = value;
      if (types.length > 0 && !types.some((t) => matches(t, v))) {
        const numeric = typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
        if (numeric !== null && types.some((t) => matches(t, numeric))) v = numeric;
        else {
          problems.push(`${key} must be ${types.map(article).join(" or ")}, not ${JSON.stringify(value)}`);
          continue;
        }
      }
      if (spec.enum && !spec.enum.includes(v)) {
        problems.push(`${key} must be one of ${spec.enum.join(", ")}, not ${JSON.stringify(value)}`);
        continue;
      }
      if (typeof v === "number" && ((spec.minimum !== undefined && v < spec.minimum) || (spec.maximum !== undefined && v > spec.maximum))) {
        problems.push(`${key} must be between ${spec.minimum ?? "-∞"} and ${spec.maximum ?? "∞"}`);
        continue;
      }
      out[key] = v;
    }
    // Missing means not sent at all; a value of the wrong type was already reported above.
    const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
    if (missing.length > 0) problems.unshift(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required`);
    return problems.length > 0 ? { error: `${capitalize(problems.join("; "))}.` } : { args: out };
  }

  function matches(type, v) {
    if (type === "integer") return Number.isInteger(v);
    if (type === "number") return typeof v === "number" && Number.isFinite(v);
    return typeof v === type;
  }

  const article = (t) => (t === "integer" ? "an integer" : `a ${t}`);
  const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  const given = (v) => v !== undefined && v !== null && v !== "" && v !== false;

  /**
   * The alert fields an add or edit may carry, copied through as given. The
   * worker validates them all again; this only converts the one thing it can't
   * read, a volume typed as "2.5M", the way the page's own form does.
   */
  function alertParams(api, args, keys) {
    const params = {};
    for (const key of keys) {
      if (given(args[key])) params[key] = args[key];
    }
    if ("volumeAtLeast" in params) {
      const shares = api.parseVolume(params.volumeAtLeast);
      if (shares === null) {
        return { error: `volumeAtLeast must be a share count such as 2.5M, 250K or 1500000, not "${String(params.volumeAtLeast)}". For a multiple of normal volume use volumeRatio.` };
      }
      params.volumeAtLeast = shares;
    }
    return { params };
  }

  // Share counts read as the page writes them (2.5M), not as the number that goes to the worker.
  const describeParams = (api, params) =>
    Object.entries(params)
      .map(([k, v]) => (v === true ? k : `${k} ${k === "volumeAtLeast" ? api.formatVolume(v) : v}`))
      .join(", ");

  const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const pendingFor = (api, key, value) => api.pending().filter((p) => p[key] === value);

  async function findAlert(api, alertId) {
    const doc = await api.alerts();
    return doc?.alerts.find((a) => a.id === alertId) ?? null;
  }

  /**
   * The dashboard document, waiting for the first one if it hasn't arrived.
   *
   * Tools register as soon as the script runs, before the page's first fetch
   * of dashboard.json returns. Against the live site (2026-09-30) an agent
   * calling straight after load got "hasn't loaded yet" - the local fixture
   * server was always faster, so no test saw it. A short wait is better than
   * a refusal the agent has to know to retry.
   */
  async function loadedDashboard(api) {
    const now = api.dashboard();
    if (now) return now;
    await Promise.race([api.loaded(), new Promise((r) => setTimeout(r, DASHBOARD_WAIT_MS))]);
    return api.dashboard();
  }
  const DASHBOARD_WAIT_MS = 10_000;

  async function findRevisit(api, revisitId) {
    return (await loadedDashboard(api))?.revisitQueue.find((r) => r.id === revisitId) ?? null;
  }

  // ---- schemas ---------------------------------------------------------------

  const symbolProp = { type: "string", description: "Ticker symbol, e.g. GMED." };
  const alertIdProp = { type: "string", description: "An alert's id, from list_alerts or list_revisit_queue." };
  const revisitIdProp = { type: "string", description: "A revisit queue entry's id, from list_revisit_queue." };
  const lotIdProp = { type: "string", description: "A lot's id, from get_position." };
  const stopIdProp = { type: "string", description: "A stop's id, from get_position." };

  const ALERT_FIELDS = {
    level: { type: "number", description: "Price to watch: a static alert. Above 0." },
    direction: {
      type: "string",
      enum: ["up", "down", "either"],
      description:
        "Which crossings of `level` fire it (default up). For a trailing alert (required): up fires on a rise off the low since it was added, down on a fall off the high. For a moving-average cross: up or down.",
    },
    trailPercent: { type: "number", description: "Trailing alert: trail distance as a percent. Give it or trailAmount, with a direction, and no level." },
    trailAmount: { type: "number", description: "Trailing alert: trail distance in dollars." },
    ma: {
      type: "string",
      description: "Moving average, as <sma|ema><period>@<1D|1W|15m|5m|2m|1m>, e.g. sma200@1D. Can't be combined with a level. A cross can carry a volume condition, counted from the cross; a touch can't.",
    },
    touch: {
      type: ["number", "boolean"],
      description: "Moving average only: fire on a touch instead of a cross. true for the default band, or a band as a percent of the average.",
    },
    from: { type: "string", enum: ["above", "below", "either"], description: "Moving-average touch only: which side price approaches from. add_alert accepts only above or below." },
    volumeAtLeast: {
      type: ["string", "number"],
      description: "Volume condition as a share count: 2.5M, 250K or 1500000. Alone it makes a volume alert; with a level it is an AND condition.",
    },
    volumeRatio: { type: "number", description: "Volume condition as a multiple of normal volume, e.g. 2. Use this or volumeAtLeast." },
    volumePeriod: {
      type: "string",
      description: "Window the volume is measured over: a number and a unit (s, m, h, d), e.g. 5d. Omit for today. A window in s/m/h over 8 days isn't accepted; give it in days.",
    },
  };

  const ADD_KEYS = ["level", "direction", "trailPercent", "trailAmount", "ma", "touch", "from", "volumeAtLeast", "volumeRatio", "volumePeriod"];
  const EDIT_KEYS = ["level", "direction", "trailPercent", "trailAmount", "ma", "touch", "from", "volumeAtLeast", "volumeRatio", "volumePeriod"];
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, ALERT_FIELDS[k]]));

  const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

  // ---- the tools ---------------------------------------------------------------
  //
  // group: read (always), write (editing unlocked), holdings (vault open and
  // shared). `ops` names the op types a write tool can queue, which the test
  // uses to tie each tool to OP_TYPES.

  const TOOLS = [
    // -- reads ---------------------------------------------------------------
    {
      name: "get_overview",
      group: "read",
      description:
        "The dashboard at a glance: counts of live alerts, open and actionable revisit entries, triggers in the window, when the next scheduled check runs, and whether the Schwab login has expired (checks are paused while it has).",
      // descriptionFor() appends the host's paragraph on how access is granted.
      accessNote: true,
      inputSchema: object({}),
      async run(api) {
        const d = await loadedDashboard(api);
        if (!d) return refuse("The dashboard hasn't loaded yet. Try again in a moment.");
        return say({
          generatedAt: d.generatedAt,
          summary: d.summary,
          nextCheck: api.scheduleText(),
          schwabLoginExpiredSince: api.loginExpiredSince(),
          pendingChanges: api.pending().length,
          editingUnlocked: api.canEdit(),
        });
      },
    },
    {
      name: "list_revisit_queue",
      group: "read",
      description:
        "Fires waiting for a decision, highest priority first. Each has the alert's current condition, the engine's verdict, a suggested new level when one has been proposed, and any change already queued against it. Use the ids with the revisit tools.",
      inputSchema: object({}),
      async run(api) {
        const d = await loadedDashboard(api);
        if (!d) return refuse("The dashboard hasn't loaded yet. Try again in a moment.");
        return say(
          d.revisitQueue.map((r) => ({
            id: r.id,
            alertId: r.alertId,
            symbol: r.symbol,
            priority: r.priority,
            headline: r.headline,
            action: r.action,
            verdict: r.verdict,
            triggeredAt: r.triggeredAt,
            triggerPrice: r.triggerPrice,
            levelAtTrigger: r.levelAtTrigger,
            suggestedLevel: r.suggestedLevel,
            suggestionBasis: r.suggestionBasis,
            daysOpen: r.daysOpen,
            heldPosition: r.heldPosition,
            alertCondition: r.alertCondition,
            updates: r.updates,
            sinceTrigger: r.sinceTrigger,
            queuedChanges: pendingFor(api, "revisitId", r.id).map((p) => p.summary),
          }))
        );
      },
    },
    {
      name: "list_alerts",
      group: "read",
      description:
        "Live alerts from the alert book (several hundred), filtered and capped. Give a symbol prefix or a kind to narrow it; the reply says how many matched. Returns each alert's id, condition, level and distance from price.",
      inputSchema: object({
        symbol: { type: "string", description: "Symbol prefix to match, e.g. AA matches AAPL and AAL." },
        kind: { type: "string", enum: ["static", "trailing", "ma", "volume"], description: "Only alerts of this kind." },
        sort: { type: "string", enum: ["symbol", "closest", "triggers"], description: "symbol (default), closest to its level, or most triggered." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to return (default 50)." },
      }),
      async run(api, args) {
        const doc = await api.alerts();
        if (!doc) return refuse("The alert book couldn't be loaded.");
        const prefix = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
        let rows = doc.alerts.filter((a) => (prefix === "" || a.symbol.toUpperCase().startsWith(prefix)) && (!args.kind || a.kind === args.kind));
        const matched = rows.length;
        const gap = (a) => (a.vsLevelPct === null ? Infinity : Math.abs(a.vsLevelPct));
        if (args.sort === "closest") rows = [...rows].sort((a, b) => gap(a) - gap(b));
        else if (args.sort === "triggers") rows = [...rows].sort((a, b) => b.triggerCount - a.triggerCount);
        else rows = [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol));
        const limit = Number.isInteger(args.limit) ? Math.min(200, Math.max(1, args.limit)) : 50;
        return say({
          matched,
          returned: Math.min(matched, limit),
          alerts: rows.slice(0, limit).map((a) => ({
            id: a.id,
            symbol: a.symbol,
            kind: a.kind,
            condition: a.condition,
            level: a.level,
            movingLevel: a.movingLevel,
            direction: a.direction,
            volume: a.volume,
            price: a.price,
            vsLevelPct: a.vsLevelPct,
            triggerCount: a.triggerCount,
            lastTriggeredAt: a.lastTriggeredAt,
            heldPosition: a.heldPosition,
          })),
        });
      },
    },
    {
      name: "get_alert",
      group: "read",
      description: "One alert in full, with its recent fires. Give its id, or a symbol to get every live alert on that symbol.",
      inputSchema: object({ alertId: alertIdProp, symbol: symbolProp }),
      async run(api, args) {
        const doc = await api.alerts();
        if (!doc) return refuse("The alert book couldn't be loaded.");
        const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
        if (!args.alertId && symbol === "") return refuse("Give an alertId or a symbol.");
        const found = doc.alerts.filter((a) => (args.alertId ? a.id === args.alertId : a.symbol.toUpperCase() === symbol));
        if (found.length === 0) return refuse("No live alert matches. It may have been removed; list_alerts shows what exists.");
        const fires = (await loadedDashboard(api))?.recentTriggers ?? [];
        return say(
          found.map((a) => ({
            ...a,
            chartUrl: undefined,
            recentFires: fires
              .filter((t) => t.alertId === a.id)
              .slice(0, 5)
              .map((t) => ({ id: t.id, headline: t.headline, triggeredAt: t.triggeredAt, triggerPrice: t.triggerPrice, verdict: t.verdict, status: t.status })),
            queuedChanges: pendingFor(api, "alertId", a.id).map((p) => p.summary),
          }))
        );
      },
    },
    {
      name: "get_chart_url",
      group: "read",
      description:
        "A link to a symbol's TradingView chart, in dark mode, for the person to open. The exchange comes from the dashboard's company profiles when it knows the symbol; pass exchange (e.g. NYSE, NASDAQ, AMEX) to choose one yourself. Without either the link is the bare symbol and TradingView picks the listing, which for some tickers is a foreign one; the result says which happened.",
      inputSchema: object(
        {
          symbol: symbolProp,
          exchange: { type: "string", description: "TradingView exchange prefix, e.g. NYSE or NASDAQ. Optional; overrides the dashboard's own." },
        },
        ["symbol"]
      ),
      async run(api, args) {
        const symbol = args.symbol.trim().toUpperCase();
        if (!/^[A-Z0-9$^][A-Z0-9.\-/$^]{0,19}$/.test(symbol)) return refuse("That doesn't look like a ticker symbol.");
        const chosen = typeof args.exchange === "string" ? args.exchange.trim().toUpperCase() : "";
        if (chosen !== "" && !/^[A-Z0-9_]{1,20}$/.test(chosen)) return refuse("exchange should be a TradingView prefix such as NYSE or NASDAQ.");
        const known = (await loadedDashboard(api))?.tradingViewPrefixes?.[symbol] ?? null;
        const exchange = chosen || known;
        const query = exchange ? `${exchange}:${symbol}` : symbol;
        return say({
          symbol,
          exchange,
          exchangeFrom: chosen ? "given" : known ? "dashboard" : "none: TradingView picks the listing",
          // theme=dark: verified 2026-09-30 to switch the chart page to its dark theme
          // for a visitor who isn't logged in; a logged-in account's own theme may win.
          url: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(query)}&theme=dark`,
        });
      },
    },
    {
      name: "get_pending_changes",
      group: "read",
      description:
        "Changes queued from this page that the worker hasn't confirmed yet, plus the most recent outcomes it published (applied or rejected, with its message). Each waiting change names what it targets: its symbol, the alert (for get_alert) and the revisit entry, where it has them; an add has no alert until it applies. Queued changes only apply at the next scheduled check, so poll this rather than assuming a write took effect.",
      inputSchema: object({}),
      async run(api) {
        const results = (await loadedDashboard(api))?.opResults ?? [];
        return say({
          nextCheck: api.scheduleText(),
          schwabLoginExpiredSince: api.loginExpiredSince(),
          // What each change targets, as the page's pending drawer links to it.
          // `?? null`: a list saved before these were recorded may lack them.
          waiting: api.pending().map((p) => ({
            opId: p.id,
            type: p.type,
            change: p.summary,
            symbol: p.symbol ?? null,
            alertId: p.alertId ?? null,
            revisitId: p.revisitId ?? null,
            queuedAt: p.queuedAt,
          })),
          recentOutcomes: results.slice(-15).map((r) => ({ opId: r.id, type: r.type, ok: r.ok, message: r.message, appliedAt: r.appliedAt })),
        });
      },
    },

    // -- alert writes ---------------------------------------------------------
    {
      name: "add_alert",
      group: "write",
      ops: ["alert.add"],
      description:
        "Queue a new alert. Give exactly one shape: a `level` (with optional `direction`); one of trailPercent/trailAmount with a `direction` (trailing, starting from the live price); `ma` (moving average); or only a volume condition. A level, a trail or a moving-average cross can also carry a volume condition, which counts only volume traded after the price condition is met. Replaces any live alert already on the same side of the price for that symbol. The person is asked to approve; the change applies at the next scheduled check.",
      // The worker's add path takes a touch's approach as above|below only; an edit also takes either.
      inputSchema: object({ symbol: symbolProp, ...pick(ADD_KEYS), from: { ...ALERT_FIELDS.from, enum: ["above", "below"] } }, ["symbol"]),
      run(api, args, signal) {
        const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
        if (symbol === "") return refuse("Give the symbol.");
        const built = alertParams(api, args, ADD_KEYS);
        if (built.error) return refuse(built.error);
        if (Object.keys(built.params).length === 0) return refuse("Give a level, a trail with a direction, ma, or a volume condition.");
        return queue(api, "write", signal, {
          op: { type: "alert.add", params: { symbol, ...built.params } },
          symbol,
          summary: `add ${symbol} alert: ${describeParams(api, built.params)}`,
        });
      },
    },
    {
      name: "edit_alert",
      group: "write",
      ops: ["alert.edit"],
      description:
        "Queue a change to one alert, by id. Send only what changes. `clearLevel` turns a price or trailing alert with a volume condition into a volume alert; `clearVolume` drops the volume condition. A trail (trailPercent or trailAmount) with a `direction` of up or down turns a price or volume alert into a trailing one, starting from the live price; a `level` turns a trailing alert back into a price alert. A new `direction` on a trailing alert restarts it from the live price. Rejected at apply time if the alert has changed since this call read it. The person is asked to approve.",
      inputSchema: object(
        {
          alertId: alertIdProp,
          ...pick(EDIT_KEYS),
          clearLevel: { type: "boolean", description: "Drop the level or trail, leaving a volume-only alert." },
          clearVolume: { type: "boolean", description: "Drop the volume condition." },
        },
        ["alertId"]
      ),
      async run(api, args, signal) {
        const built = alertParams(api, args, [...EDIT_KEYS, "clearLevel", "clearVolume"]);
        if (built.error) return refuse(built.error);
        if (Object.keys(built.params).length === 0) return refuse("Nothing to change.");
        const alert = await findAlert(api, args.alertId);
        if (!alert) return refuse("No live alert has that id. It may have been removed; list_alerts shows what exists.");
        if (pendingFor(api, "alertId", alert.id).some((p) => p.type === "alert.remove")) return refuse("A removal of this alert is already queued.");
        return queue(api, "write", signal, {
          op: { type: "alert.edit", target: { alertId: alert.id }, expect: { condition: alert.condition }, params: built.params },
          symbol: alert.symbol,
          alertId: alert.id,
          summary: `edit ${alert.symbol} alert "${alert.condition}": ${describeParams(api, built.params)}`,
        });
      },
    },
    {
      name: "remove_alert",
      group: "write",
      ops: ["alert.remove"],
      description:
        "Queue deleting one alert, by id. Its history goes with it. Rejected at apply time if the alert has changed since this call read it. The person is asked to approve.",
      inputSchema: object({ alertId: alertIdProp }, ["alertId"]),
      async run(api, args, signal) {
        const alert = await findAlert(api, args.alertId);
        if (!alert) return refuse("No live alert has that id. It may already be removed.");
        if (pendingFor(api, "alertId", alert.id).some((p) => p.type === "alert.remove")) return refuse("A removal of this alert is already queued.");
        return queue(api, "write", signal, {
          op: { type: "alert.remove", target: { alertId: alert.id }, expect: { condition: alert.condition }, params: {} },
          symbol: alert.symbol,
          alertId: alert.id,
          summary: `${alert.symbol}: remove alert "${alert.condition}"`,
        });
      },
    },

    // -- revisit queue writes -----------------------------------------------------
    {
      name: "dismiss_revisit",
      group: "write",
      ops: ["revisit.dismiss"],
      description:
        "Queue taking one fire off the revisit queue. The alert is untouched: it keeps its level and keeps watching, and its next fire comes back as a new entry. The person is asked to approve.",
      inputSchema: object({ revisitId: revisitIdProp }, ["revisitId"]),
      async run(api, args, signal) {
        const r = await findRevisit(api, args.revisitId);
        if (!r) return refuse("No open queue entry has that id. It may already be closed; list_revisit_queue shows what is open.");
        if (pendingFor(api, "revisitId", r.id).length > 0) return refuse("A change is already queued for this entry.");
        return queue(api, "write", signal, {
          op: { type: "revisit.dismiss", target: { revisitId: r.id, alertId: r.alertId }, params: {} },
          symbol: r.symbol,
          alertId: r.alertId,
          revisitId: r.id,
          summary: `${r.symbol}: dismiss the ${shortDate(r.triggeredAt)} fire${r.levelAtTrigger === null ? "" : ` at ${r.levelAtTrigger}`} from the queue`,
        });
      },
    },
    {
      name: "relevel_revisit",
      group: "write",
      ops: ["revisit.relevel"],
      description:
        "Queue asking the worker to fetch recent bars, propose a new level for one queue entry and re-score it. Changes nothing on the alert. Read the suggestion from list_revisit_queue once it has been applied. The person is asked to approve.",
      inputSchema: object({ revisitId: revisitIdProp }, ["revisitId"]),
      async run(api, args, signal) {
        const r = await findRevisit(api, args.revisitId);
        if (!r) return refuse("No open queue entry has that id.");
        if (pendingFor(api, "revisitId", r.id).length > 0) return refuse("A change is already queued for this entry.");
        return queue(api, "write", signal, {
          op: { type: "revisit.relevel", target: { revisitId: r.id }, params: {} },
          symbol: r.symbol,
          alertId: r.alertId,
          revisitId: r.id,
          summary: `${r.symbol}: suggest a new level for the ${shortDate(r.triggeredAt)} fire`,
        });
      },
    },
    {
      name: "apply_revisit",
      group: "write",
      ops: ["revisit.apply"],
      description:
        "Queue moving the alert onto the level suggested for a queue entry, and closing the entry. Needs a suggestion (see relevel_revisit) and a live alert. Rejected at apply time if either has changed since this call read them. The person is asked to approve.",
      inputSchema: object({ revisitId: revisitIdProp }, ["revisitId"]),
      async run(api, args, signal) {
        const r = await findRevisit(api, args.revisitId);
        if (!r) return refuse("No open queue entry has that id.");
        if (r.suggestedLevel === null) return refuse("This entry has no suggested level yet. Queue relevel_revisit first.");
        if (!r.alertCondition) return refuse("The alert behind this fire has been removed, so there is nothing to move.");
        if (pendingFor(api, "revisitId", r.id).length > 0) return refuse("A change is already queued for this entry.");
        return queue(api, "write", signal, {
          op: {
            type: "revisit.apply",
            target: { revisitId: r.id, alertId: r.alertId },
            expect: { suggestedLevel: r.suggestedLevel, condition: r.alertCondition },
            params: {},
          },
          symbol: r.symbol,
          alertId: r.alertId,
          revisitId: r.id,
          summary: `${r.symbol}: move the alert${r.levelAtTrigger === null ? "" : ` from ${r.levelAtTrigger}`} to ${r.suggestedLevel}`,
        });
      },
    },

    // -- holdings reads -----------------------------------------------------------
    {
      name: "list_positions",
      group: "holdings",
      description: "Every position: shares, blended basis, price, gain from basis, market value, stops and account labels. Private: this is the size and value of the person's holdings.",
      inputSchema: object({}),
      run(api) {
        const v = api.vault();
        return say(
          v.holdings.map((h) => ({
            symbol: h.symbol,
            shares: h.shares,
            basis: h.basis,
            price: h.price,
            pctFromBasis: h.pctFromBasis,
            marketValue: h.marketValue,
            lastPurchaseDate: h.lastPurchaseDate,
            stops: h.stops,
            accounts: h.accounts,
            ignoredByAlerts: h.ignored,
          }))
        );
      },
    },
    {
      name: "get_position",
      group: "holdings",
      description: "One position with its lots and stops, each with the id the lot and stop tools take, and the live alerts on the symbol.",
      inputSchema: object({ symbol: symbolProp }, ["symbol"]),
      async run(api, args) {
        const symbol = String(args.symbol ?? "").trim().toUpperCase();
        const v = api.vault();
        const row = v.holdings.find((h) => h.symbol.toUpperCase() === symbol);
        if (!row) return refuse(`${symbol || "That symbol"} isn't a position.`);
        const doc = await api.alerts();
        return say({
          position: row,
          lots: v.lots.filter((l) => l.symbol.toUpperCase() === symbol),
          stops: v.stops.filter((s) => s.symbol.toUpperCase() === symbol),
          alerts: (doc?.alerts ?? []).filter((a) => a.symbol.toUpperCase() === symbol).map((a) => ({ id: a.id, condition: a.condition })),
        });
      },
    },
    {
      name: "get_stories",
      group: "holdings",
      description: "Multi-fire stories that weave the person's buys and sales in with the alerts. Without a symbol, a one-line summary per story; with one, the full story. Private: it tells when they bought and sold.",
      inputSchema: object({ symbol: symbolProp }),
      run(api, args) {
        const stories = api.vault().stories ?? [];
        const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
        if (symbol === "") return say(stories.map((s) => ({ symbol: s.symbol, held: s.held, summary: s.summary })));
        const story = stories.find((s) => s.symbol.toUpperCase() === symbol);
        return story ? say(story) : refuse(`No story for ${symbol}.`);
      },
    },

    // -- holdings writes ----------------------------------------------------------
    {
      name: "add_lot",
      group: "holdings",
      ops: ["lot.add"],
      description:
        "Queue a purchase: a lot of shares at a basis per share. With stopPrice, replaces the symbol's existing stop(s) with that one. Merges into the position, and the symbol gets a starting alert at the next check if it has none. The person is asked to approve.",
      inputSchema: object(
        {
          symbol: symbolProp,
          count: { type: "number", description: "Shares bought. Above 0." },
          basisPerShare: { type: "number", description: "Price paid per share. Above 0." },
          purchaseDate: { type: "string", description: "YYYY-MM-DD. Defaults to the day the worker applies it." },
          account: { type: "string", description: "Account label, up to 40 characters." },
          stopPrice: { type: "number", description: "Also set a stop at this price, replacing the symbol's existing stops." },
          stopCount: { type: "number", description: "Shares the stop covers. Needs stopPrice; omit for all." },
        },
        ["symbol", "count", "basisPerShare"]
      ),
      run(api, args, signal) {
        const symbol = String(args.symbol ?? "").trim().toUpperCase();
        if (symbol === "") return refuse("Give the symbol.");
        const params = { symbol };
        for (const key of ["count", "basisPerShare", "purchaseDate", "account", "stopPrice", "stopCount"]) {
          if (given(args[key])) params[key] = args[key];
        }
        const stopNote = params.stopPrice === undefined ? "" : `, stop ${params.stopPrice}`;
        return queue(api, "holdings", signal, {
          op: { type: "lot.add", params },
          symbol,
          summary: `add ${params.count} ${symbol} @ ${params.basisPerShare}${stopNote}`,
        });
      },
    },
    {
      name: "edit_lot",
      group: "holdings",
      ops: ["lot.edit"],
      description:
        "Queue a change to one lot, by id. Send only what changes; an empty account clears the label. Rejected at apply time if the lot has changed since this call read it. The person is asked to approve.",
      inputSchema: object(
        {
          lotId: lotIdProp,
          count: { type: "number", description: "New share count. Above 0." },
          basisPerShare: { type: "number", description: "New basis per share. Above 0." },
          purchaseDate: { type: "string", description: "YYYY-MM-DD." },
          account: { type: "string", description: "Account label; an empty string clears it." },
        },
        ["lotId"]
      ),
      run(api, args, signal) {
        const lot = api.vault().lots.find((l) => l.id === args.lotId);
        if (!lot) return refuse("No lot has that id. get_position lists a position's lots.");
        const params = {};
        for (const key of ["count", "basisPerShare", "purchaseDate"]) {
          if (given(args[key])) params[key] = args[key];
        }
        // An empty string is meaningful here: it clears the label.
        if (typeof args.account === "string") params.account = args.account;
        if (Object.keys(params).length === 0) return refuse("Nothing to change.");
        return queue(api, "holdings", signal, {
          op: { type: "lot.edit", target: { lotId: lot.id }, expect: lotExpect(lot), params },
          symbol: lot.symbol,
          summary: `edit ${lot.symbol} lot (${lot.count} @ ${lot.basisPerShare}): ${describeParams(api, params)}`,
        });
      },
    },
    {
      name: "remove_lot",
      group: "holdings",
      ops: ["lot.remove"],
      description:
        "Queue deleting one lot, by id. Rejected at apply time if the lot has changed since this call read it. The person is asked to approve.",
      inputSchema: object({ lotId: lotIdProp }, ["lotId"]),
      run(api, args, signal) {
        const lot = api.vault().lots.find((l) => l.id === args.lotId);
        if (!lot) return refuse("No lot has that id.");
        return queue(api, "holdings", signal, {
          op: { type: "lot.remove", target: { lotId: lot.id }, expect: lotExpect(lot), params: {} },
          symbol: lot.symbol,
          summary: `remove a ${lot.symbol} lot (${lot.count} @ ${lot.basisPerShare})`,
        });
      },
    },
    {
      name: "remove_position",
      group: "holdings",
      ops: ["position.remove"],
      description:
        "Queue deleting a whole position: every lot and stop for the symbol. Rejected at apply time if a lot has been added or removed since this call read them. The person is asked to approve.",
      inputSchema: object({ symbol: symbolProp }, ["symbol"]),
      run(api, args, signal) {
        const symbol = String(args.symbol ?? "").trim().toUpperCase();
        const lots = api.vault().lots.filter((l) => l.symbol.toUpperCase() === symbol);
        if (lots.length === 0) return refuse(`${symbol || "That symbol"} isn't a position.`);
        return queue(api, "holdings", signal, {
          op: { type: "position.remove", target: { symbol }, expect: { lotIds: lots.map((l) => l.id) }, params: {} },
          symbol,
          summary: `remove the ${symbol} position`,
        });
      },
    },
    {
      name: "add_stop",
      group: "holdings",
      ops: ["stop.add"],
      description: "Queue a stop price for a position. Stops are records only; nothing watches them yet. The person is asked to approve.",
      inputSchema: object(
        {
          symbol: symbolProp,
          stopPrice: { type: "number", description: "Stop price. Above 0." },
          count: { type: "number", description: "Shares the stop covers. Omit for all held." },
        },
        ["symbol", "stopPrice"]
      ),
      run(api, args, signal) {
        const symbol = String(args.symbol ?? "").trim().toUpperCase();
        if (symbol === "") return refuse("Give the symbol.");
        const params = { symbol, stopPrice: args.stopPrice, ...(given(args.count) ? { count: args.count } : {}) };
        return queue(api, "holdings", signal, {
          op: { type: "stop.add", params },
          symbol,
          summary: `add ${symbol} stop at ${params.stopPrice}${params.count === undefined ? "" : ` for ${params.count} shares`}`,
        });
      },
    },
    {
      name: "edit_stop",
      group: "holdings",
      ops: ["stop.edit"],
      description:
        "Queue moving a stop, by id. `stopPrice` is required; `count` is left as it is when omitted. Rejected at apply time if the stop has been moved since this call read it. The person is asked to approve.",
      inputSchema: object(
        {
          stopId: stopIdProp,
          stopPrice: { type: "number", description: "New stop price. Above 0." },
          count: { type: "number", description: "New number of shares covered." },
        },
        ["stopId", "stopPrice"]
      ),
      run(api, args, signal) {
        const stop = api.vault().stops.find((s) => s.id === args.stopId);
        if (!stop) return refuse("No stop has that id. get_position lists a position's stops.");
        const params = { stopPrice: args.stopPrice, ...(given(args.count) ? { count: args.count } : {}) };
        return queue(api, "holdings", signal, {
          op: { type: "stop.edit", target: { stopId: stop.id }, expect: { stopPrice: stop.stopPrice }, params },
          symbol: stop.symbol,
          summary: `move ${stop.symbol} stop from ${stop.stopPrice} to ${params.stopPrice}${params.count === undefined ? "" : ` for ${params.count} shares`}`,
        });
      },
    },
    {
      name: "remove_stop",
      group: "holdings",
      ops: ["stop.remove"],
      description: "Queue deleting one stop, by id. Rejected at apply time if the stop has been moved since this call read it. The person is asked to approve.",
      inputSchema: object({ stopId: stopIdProp }, ["stopId"]),
      run(api, args, signal) {
        const stop = api.vault().stops.find((s) => s.id === args.stopId);
        if (!stop) return refuse("No stop has that id.");
        return queue(api, "holdings", signal, {
          op: { type: "stop.remove", target: { stopId: stop.id }, expect: { stopPrice: stop.stopPrice }, params: {} },
          symbol: stop.symbol,
          summary: `remove ${stop.symbol} stop at ${stop.stopPrice}`,
        });
      },
    },
    {
      name: "cover_position",
      group: "holdings",
      ops: ["holdings.cover"],
      description:
        "Queue giving a position that has no live alert a starting one, at 10% above the higher of its price and basis. Skipped by the worker if the symbol already has a live alert. The person is asked to approve.",
      inputSchema: object({ symbol: symbolProp }, ["symbol"]),
      run(api, args, signal) {
        const symbol = String(args.symbol ?? "").trim().toUpperCase();
        if (!api.vault().holdings.some((h) => h.symbol.toUpperCase() === symbol)) return refuse(`${symbol || "That symbol"} isn't a position.`);
        return queue(api, "holdings", signal, {
          op: { type: "holdings.cover", target: { symbol }, params: {} },
          symbol,
          summary: `give ${symbol} a starting alert`,
        });
      },
    },
  ];

  // ---- entry points both hosts use ---------------------------------------------------

  /** Whether the host's current state offers this tool. */
  const available = (tool, api) => AVAILABLE[tool.group](api);

  /**
   * Runs one call the way every host must: the tool's own gate (a reference
   * kept past a lock still refuses), then its inputSchema (no host enforces
   * it for us; see checkArgs), then the tool. An exception is reported as a
   * refusal rather than thrown back into the host.
   */
  async function callTool(tool, api, args, signal) {
    if (!available(tool, api)) return refuse(lockedMessage(api, tool.group));
    const checked = checkArgs(tool.inputSchema, args);
    if (checked.error) return refuse(`${tool.name}: ${checked.error}`);
    try {
      return await tool.run(api, checked.args, signal);
    } catch (err) {
      return refuse(`The dashboard failed while running ${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Splits a host's pending changes by what the published document says about
   * them: `done` have a result, `processed` were queued before the last drain
   * started and so were applied even though their result has aged out of the
   * document, and `waiting` are neither. The page's resolvePending and the MCP
   * server's pending file both settle through this, so the watermark rule has
   * one home.
   */
  function settlePending(pending, results, processedThrough) {
    const byId = new Map((results ?? []).map((r) => [r.id, r]));
    const done = pending.filter((p) => byId.has(p.id)).map((p) => ({ pending: p, result: byId.get(p.id) }));
    const cutoff = processedThrough ? new Date(processedThrough).getTime() : null;
    const processed = cutoff === null ? [] : pending.filter((p) => !byId.has(p.id) && new Date(p.queuedAt).getTime() < cutoff);
    const retired = new Set([...done.map((d) => d.pending.id), ...processed.map((p) => p.id)]);
    return { done, processed, waiting: pending.filter((p) => !retired.has(p.id)) };
  }

  /** What a lot looked like when read, so the worker can refuse an edit to something else. Mirrors lotExpect in app.js. */
  const lotExpect = (lot) => ({ count: lot.count, basisPerShare: lot.basisPerShare, purchaseDate: lot.purchaseDate, account: lot.account ?? null });

  // ---- registering with the browser ---------------------------------------------

  /**
   * The object tools are registered on. The spec's current text puts it on
   * `document`; the early preview and most write-ups use `navigator`. A page
   * served with an origin-trial token has been seen to expose only the first.
   */
  function host() {
    const fromDocument = typeof document !== "undefined" ? document.modelContext : undefined;
    const fromNavigator = typeof navigator !== "undefined" ? navigator.modelContext : undefined;
    const mc = fromDocument ?? fromNavigator ?? null;
    return mc && typeof mc.registerTool === "function" ? mc : null;
  }

  const supported = () => host() !== null;

  /**
   * Registers whichever tools the page's state allows and keeps them in step
   * with it. `sync()` is idempotent and cheap, so app.js calls it wherever the
   * unlock state or the holdings switch might have changed.
   */
  function start(api) {
    const live = new Map(); // tool name -> AbortController

    function add(mc, tool) {
      const controller = new AbortController();
      const descriptor = {
        name: tool.name,
        description: descriptionFor(tool, api),
        inputSchema: tool.inputSchema,
        annotations: annotationsFor(tool),
        execute: (args, options) => callTool(tool, api, args, options?.signal),
      };
      const failed = (err) => {
        live.delete(tool.name);
        console.warn(`WebMCP: couldn't register ${tool.name}:`, err);
      };
      try {
        const registered = mc.registerTool(descriptor, { signal: controller.signal });
        live.set(tool.name, controller);
        if (registered && typeof registered.catch === "function") registered.catch(failed);
      } catch (err) {
        failed(err);
      }
    }

    function drop(mc, name) {
      live.get(name)?.abort(); // the current spec: aborting the signal unregisters
      live.delete(name);
      if (typeof mc.unregisterTool === "function") {
        try {
          mc.unregisterTool(name); // the early preview
        } catch {
          /* already gone */
        }
      }
    }

    function sync() {
      const mc = host();
      if (!mc) return;
      for (const tool of TOOLS) {
        const wanted = available(tool, api);
        if (wanted && !live.has(tool.name)) add(mc, tool);
        else if (!wanted && live.has(tool.name)) drop(mc, tool.name);
      }
    }

    sync();
    return { sync, registered: () => [...live.keys()] };
  }

  root.equityWatchWebMcp = { start, supported, checkArgs, callTool, available, descriptionFor, annotationsFor, settlePending, TOOLS };
})(typeof window !== "undefined" ? window : globalThis);
