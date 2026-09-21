// Browser dashboard.
//
// Views are hash routes, so the poller and notifications keep running
// whichever one is open:
//   #/              overview        (dashboard.json, polled every minute)
//   #/queue         the revisit queue (dashboard.json)
//   #/stories       multi-trigger stories (dashboard.json)
//   #/alerts        every live alert (alerts.json, fetched while viewed)
//   #/holdings      positions, lots, and stops (vault.json, decrypted once editing is unlocked)
//   #/trigger/<id>  one trigger's details, in a drawer over the current view
//   #/alert/<id>    one alert's details and its recent triggers
//
// Every string from the documents is inserted with textContent, never
// innerHTML: symbols ultimately come from imported CSVs. Every sentence shown
// is either read off the documents or a fixed label here; nothing is inferred.

(() => {
  "use strict";

  const POLL_MS = 60_000;
  const SEEN_KEY = "equity-watch.seenTriggers";
  const THEME_KEY = "equity-watch.theme";
  // Keys from before the project was renamed, read as a fallback so a browser
  // keeps its seen triggers and theme. index.html reads the old theme key too.
  const LEGACY_SEEN_KEY = "tva.seenTriggers";
  const CLI = "node dist/cli.js";

  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---- storage (may be unavailable in private windows) ----------------------

  function loadSeen() {
    try {
      const raw = storageGet(SEEN_KEY) ?? storageGet(LEGACY_SEEN_KEY);
      return raw === null ? null : new Set(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function saveSeen(set) {
    storageSet(SEEN_KEY, JSON.stringify([...set]));
  }

  // ---- formatting -----------------------------------------------------------

  const money = (n) =>
    n === null || n === undefined ? "–" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
  // ---- volumes ---------------------------------------------------------------
  //
  // Share counts in and out: "2.5M" typed into the edit form, "2.5M" wherever a
  // volume is shown. A byte-for-byte copy of src/volume.ts, because the page is
  // served as plain files with no bundler and cannot import it. The page must
  // reject and render exactly what the worker does, so tests/volume.test.ts
  // evaluates this block and checks both agree. Change one, change the other.
  //
  // Not Intl compact notation, which this used to be: that is locale-dependent
  // (a lowercase "k" in some locales, a different suffix in others), and the
  // worker's own rendering has no locale to match it against.

  const VOLUME_UNITS = [
    { suffix: "K", factor: 1e3 },
    { suffix: "M", factor: 1e6 },
    { suffix: "B", factor: 1e9 },
  ];
  const VOLUME_RE = /^([\d,]*\.?\d+)\s*([KMB]?)$/i;
  const VOLUME_DECIMALS = 2;

  const trimNumber = (n, places) => Number(n.toFixed(places));

  function scaleVolume(n) {
    const magnitude = Math.abs(n);
    let index = -1;
    for (let i = VOLUME_UNITS.length - 1; i >= 0; i--) {
      if (magnitude >= VOLUME_UNITS[i].factor) {
        index = i;
        break;
      }
    }
    if (index === -1) return { value: trimNumber(n, 0), suffix: "", factor: 1 };
    let { suffix, factor } = VOLUME_UNITS[index];
    let value = trimNumber(n / factor, VOLUME_DECIMALS);
    // Rounding can overflow the unit: 999,999 is 999.999K, which prints as
    // "1000K" at two decimals. Step up rather than say that.
    if (Math.abs(value) >= 1000 && index + 1 < VOLUME_UNITS.length) {
      ({ suffix, factor } = VOLUME_UNITS[index + 1]);
      value = trimNumber(n / factor, VOLUME_DECIMALS);
    }
    return { value, suffix, factor };
  }

  /** Shares from "2.5M", "250k", "3 M", "1,500,000" or "1500000"; null if it isn't a positive count. */
  function parseVolume(raw) {
    if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
    const match = VOLUME_RE.exec(String(raw).trim());
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = VOLUME_UNITS.find((u) => u.suffix === match[2].toUpperCase());
    return Math.round(value * (unit ? unit.factor : 1));
  }

  /** A volume for reading: "2.5M", "250K", "850". Lossy; never prefill an input with it. */
  function formatVolume(n) {
    if (!Number.isFinite(n)) return String(n);
    const { value, suffix } = scaleVolume(n);
    return `${value}${suffix}`;
  }

  /**
   * A volume for an input the user may save unchanged: exact, so a form that
   * prefills it and is submitted untouched sends back the number it started
   * with. 2,500,000 prefills as "2.5M"; 1,234,567 prefills as "1234567" rather
   * than silently becoming 1,230,000 on save.
   */
  function volumeInputValue(n) {
    if (!Number.isFinite(n)) return "";
    const { value, suffix, factor } = scaleVolume(n);
    return suffix !== "" && value * factor === n ? `${value}${suffix}` : String(trimNumber(n, 0));
  }

  // ---- end of the src/volume.ts mirror ----------------------------------
  // tests/volume.test.ts slices from VOLUME_UNITS to this line and evaluates
  // it. An explicit marker, because it used to key off the name of whatever
  // came next and a rename broke the test for reasons that read as unrelated.

  const sharesText = (n) => `${formatVolume(n)} shares`;

  function ago(iso) {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr} hr ago`;
    return `${Math.round(hr / 24)} days ago`;
  }

  function until(iso) {
    const min = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
    if (min <= 0) return "now";
    if (min < 60) return `in ${min} min`;
    const hr = Math.floor(min / 60);
    const rest = min % 60;
    if (hr < 24) return rest === 0 ? `in ${hr} hr` : `in ${hr} hr ${rest} min`;
    return `in ${Math.round(hr / 24)} days`;
  }

  function when(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
  }

  /** "at 9:00 AM" today, "on Sep 17 at 9:00 AM" otherwise. */
  function atWhen(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? `at ${time}`
      : `on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
  }

  const full = (iso) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Headlines lead with the symbol ("Holding MKS crossed below 110"). Where the
  // symbol is shown separately, drop it from the sentence; held becomes a tag.
  const bareHeadline = (t) => t.headline.replace(new RegExp(`^(Holding )?${escapeRe(t.symbol)} `), "");
  const muted = (text) => h("span", { class: "muted", text });

  // The held tag opens the Holdings view on that position, in one tab reused
  // across every click (a named target, like the chart fallback below): the
  // overview is a place you sit and watch, so checking a position shouldn't
  // navigate it away. No preventDefault - the browser's own window targeting is
  // what reuses the tab. stopPropagation only, so a tag inside a clickable row
  // or toast doesn't also open that row's details.
  const HOLDINGS_TARGET = "equity-watch-holdings";
  const holdingsHash = (symbol) => `#/holdings/${encodeURIComponent(symbol)}`;
  const heldTag = (t) =>
    t.heldPosition
      ? h("a", {
          class: "tag held",
          href: holdingsHash(t.symbol),
          target: HOLDINGS_TARGET,
          title: `Show ${t.symbol} in Holdings`,
          text: "held",
          onclick: (e) => e.stopPropagation(),
        })
      : null;

  // Every displayed ticker links to its TradingView chart. The click stops
  // there so a ticker inside a clickable row or toast doesn't also open details.
  // Rows carry a chartUrl built server-side; symbols without a row (holdings,
  // stories, quiet notes) use the document's exchange prefixes, since a bare
  // symbol like PPL opens a foreign listing (src/tradingview.ts).
  const tvUrl = (symbol) => {
    const prefix = current?.tradingViewPrefixes?.[symbol];
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(prefix ? `${prefix}:${symbol}` : symbol)}`;
  };
  // Every chart opens in the same panel (openChart), which swaps its iframe's
  // src per symbol, so clicking through tickers never piles up tabs. The href
  // and target are kept as a fallback: a modified click (ctrl/cmd/shift) or a
  // middle click skips our handler entirely and falls through to opening (or
  // reusing, by name) a real tradingview.com tab instead. No rel="noopener" on
  // that fallback: a tab opened with noopener can't be found by name again.
  const CHART_TARGET = "tradingview";
  const symbolLink = (symbol, href = tvUrl(symbol)) =>
    h("a", {
      class: "sym",
      href,
      target: CHART_TARGET,
      text: symbol,
      onclick: (e) => {
        e.stopPropagation();
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openChart(symbol, href);
      },
    });
  // For generated sentences that open with the ticker ("MKS: watching since…").
  function linkLeadingSymbol(text, symbol) {
    return symbol && text.startsWith(symbol) ? [symbolLink(symbol), text.slice(symbol.length)] : [text];
  }

  const SESSION_LABEL = { pre: "pre-market", regular: "regular hours", post: "after hours" };
  const KIND_LABEL = { static: "Static", trailing: "Trailing", volume: "Volume", ma: "Moving average" };
  // Plain names for analysis.ts verdicts. Kept literal: NO_CLOSE_CONFIRM in
  // particular must never read as a completed move. Worded for either
  // direction, since a downward crossing is judged by the same verdicts.
  const VERDICT_LABEL = {
    CONFIRMED_BREAKOUT: "Confirmed: closed past the level on rising volume, and hasn't gone back",
    WATCH: "Closed past the level on volume, but volume faded or it didn't hold",
    WATCH_WEAK: "Weak: thin volume, or the level is far from the recent high or low",
    NO: "Not confirmed",
    NO_CLOSE_CONFIRM: "Didn't close past the level",
    INSUFFICIENT_DATA: "Not enough data to judge",
    SKIPPED: "Skipped",
    PROVIDER_ERROR: "Price data unavailable",
  };

  // Static alerts' `direction`: which crossings fire them.
  const DIRECTION_LABEL = { up: "Crosses up", down: "Crosses down", either: "Either way" };
  const DIRECTION_DETAIL = {
    up: "Upward crosses (price rising through the level)",
    down: "Downward crosses (price falling through the level)",
    either: "Crosses in either direction",
  };
  const SIDE_OF = { up: "above", down: "below" };

  // Reversal: the first crossing back against a fire, precomputed in
  // dashboard.ts. Trading days, so a Friday fire reversed Monday is "next day".
  const dayText = (n) => (n === 0 ? "same day" : n === 1 ? "next day" : `${n} days later`);
  function reversalText(t) {
    if (!t.reversal || !t.direction) return null;
    const verb = t.direction === "up" ? "fell back below" : "climbed back above";
    // A trailing alert's stored level is where it started, not what it fired at.
    const level = t.levelAtTrigger !== null && t.kind !== "trailing" ? t.levelAtTrigger : "it";
    return `${verb} ${level} · ${dayText(t.reversal.tradingDaysAfter)}`;
  }
  const reversedTag = (t, withDay = false) =>
    t.reversal
      ? h("span", { class: "tag reversed", title: reversalText(t), text: withDay ? `reversed · ${dayText(t.reversal.tradingDaysAfter)}` : "reversed" })
      : null;

  const triggerHash = (id) => `#/trigger/${encodeURIComponent(id)}`;
  const alertHash = (id) => `#/alert/${encodeURIComponent(id)}`;

  function copyButton(label, command) {
    const btn = h("button", { title: command, text: label });
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(command);
        btn.textContent = "Copied";
      } catch {
        window.prompt("Copy this command:", command);
      }
      setTimeout(() => (btn.textContent = label), 1500);
    });
    return btn;
  }

  // ---- editing (ops) --------------------------------------------------------
  //
  // The page can't write alerts.json: it lives on the machine that runs the
  // checks. A change is POSTed to api/ops (a Lambda behind CloudFront), queued,
  // and applied by `ops pull` at the start of the next scheduled check. Results
  // come back in dashboard.json's opResults. The token only opens the queue;
  // the worker validates every change again against the real alert.

  const OPS_TOKEN_KEY = "equity-watch.opsToken";
  const PENDING_KEY = "equity-watch.pendingOps";

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* lasts for this tab only */
    }
  }

  let opsToken = storageGet(OPS_TOKEN_KEY);
  // { id, type, symbol, alertId, revisitId?, summary, queuedAt }, kept so a reload doesn't lose what's waiting.
  let pendingOps = (() => {
    try {
      const v = JSON.parse(storageGet(PENDING_KEY) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })();
  const savePending = () => storageSet(PENDING_KEY, JSON.stringify(pendingOps));
  const opsEnabled = () => current?.site?.ops === true;
  const canEdit = () => opsEnabled() && Boolean(opsToken);
  // Forms are built once and reused, so a poll re-rendering the view doesn't wipe what's typed.
  let addFormEl = null;
  let editForm = null; // { alertId, condition, el }

  function rerenderOps() {
    renderOpsControls();
    if (current) {
      renderTiles(current.summary, holdingRows() !== null);
      // The queue rows carry an "edit pending" tag of their own.
      renderQueue(current.revisitQueue);
    }
    if (baseView === "alerts") renderAlerts();
    renderHoldingsView();
    renderDrawer(parseRoute().drawer);
  }

  function setToken(token) {
    opsToken = token;
    storageSet(OPS_TOKEN_KEY, token);
    if (token === null) {
      vaultData = null;
      vaultError = null;
    }
    rerenderOps();
    // Opening the vault is also the first check that the token is right.
    if (token !== null) refreshVault();
  }

  function renderOpsControls() {
    const btn = $("ops-btn");
    btn.hidden = !opsEnabled();
    btn.textContent = opsToken ? "Lock editing" : "Unlock editing";
  }

  function notice(text, ok, alertId = null) {
    const el = h(
      "div",
      { class: `toast ${ok ? "ok" : "bad"}`, role: "status" },
      h("div", { class: alertId ? "t-body" : null, onclick: alertId ? () => (location.hash = alertHash(alertId)) : null, text }),
      h("button", { "aria-label": "Dismiss", text: "×", onclick: () => el.remove() })
    );
    $("toasts").append(el);
    setTimeout(() => el.remove(), ok ? 15_000 : 60_000);
  }

  async function submitOp(op, { symbol, alertId = null, revisitId = null, summary }) {
    const body = { ...op, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    let resp;
    try {
      resp = await fetch("api/ops", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opsToken}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      notice(`Couldn't queue ${summary} (${err.message}).`, false);
      return false;
    }
    if (resp.status === 401) {
      setToken(null);
      notice("The ops token was rejected. Unlock editing with the right one.", false);
      return false;
    }
    if (resp.status !== 202) {
      let reason = `HTTP ${resp.status}`;
      try {
        reason = (await resp.json()).error ?? reason;
      } catch {
        /* not JSON */
      }
      notice(`Couldn't queue ${summary}: ${reason}.`, false);
      return false;
    }
    pendingOps.push({ id: body.id, type: body.type, symbol, alertId, revisitId, summary, queuedAt: body.createdAt });
    savePending();
    notice(`Queued: ${summary}. It applies at the next scheduled check.`, true);
    rerenderOps();
    return true;
  }

  function resolvePending(results, processedThrough) {
    if (pendingOps.length === 0) return;
    const byId = new Map((results ?? []).map((r) => [r.id, r]));
    const done = pendingOps.filter((p) => byId.has(p.id));
    // A drain applies everything queued before it started, so anything older
    // than the watermark is done even when its result is no longer published
    // (the document keeps only the most recent ones).
    const cutoff = processedThrough ? new Date(processedThrough).getTime() : null;
    const processed = cutoff === null ? [] : pendingOps.filter((p) => !byId.has(p.id) && new Date(p.queuedAt).getTime() < cutoff);
    if (done.length === 0 && processed.length === 0) return;
    const retired = new Set([...done, ...processed].map((p) => p.id));
    pendingOps = pendingOps.filter((p) => !retired.has(p.id));
    savePending();
    if (processed.length === 1) {
      notice(`${processed[0].summary}: applied. Its result is no longer published.`, true);
    } else if (processed.length > 1) {
      notice(`${processed.length} earlier changes were applied. Their results are no longer published.`, true);
    }
    for (const p of done) {
      const r = byId.get(p.id);
      // Holdings results are published, so they carry no sizes or prices; the
      // page's own summary of what it sent says what was applied.
      const okText = isHoldingsOp(p) ? `Applied: ${p.summary}.` : r.message;
      notice(r.ok ? okText : `${p.summary} rejected: ${r.message}`, r.ok, r.ok ? r.alertId : p.alertId);
    }
    ensureAlerts(true);
    refreshVault();
    rerenderOps();
  }

  // How far past the expected drain to wait before calling it late rather than
  // merely due: at a 15 min cadence a run that slips a few minutes is normal.
  const OPS_OVERDUE_FACTOR = 2;

  /**
   * When the machine's Schwab login expired, or null while it is healthy.
   *
   * This outranks every other schedule signal on the page. The task may still
   * be running perfectly on its 15-minute grid, but without a login it fetches
   * no quotes, so `alert check` evaluates nothing and queued adds and level
   * edits cannot apply (both need a live price to place a level against). The
   * page must not project a next check that will not do anything.
   */
  const authExpiredSince = () => current?.opsAuthExpiredSince ?? null;

  // Changes to the alert itself. A pending dismiss names the alert too, but
  // leaves it untouched, so it must not read as "edit pending" on the alert.
  const pendingFor = (alertId) => pendingOps.filter((p) => p.alertId === alertId && p.type.startsWith("alert."));
  const pendingTag = (alertId) => {
    const queued = pendingFor(alertId);
    if (queued.length === 0) return null;
    return h("span", { class: "tag pending", text: queued.some((p) => p.type === "alert.remove") ? "remove pending" : "edit pending" });
  };
  const dismissPending = (revisitId) => pendingOps.some((p) => p.type === "revisit.dismiss" && p.revisitId === revisitId);

  function renderPending() {
    renderPendingList($("ops-pending"), pendingOps.filter((p) => !isHoldingsOp(p)));
    renderPendingList($("holdings-pending"), pendingOps.filter(isHoldingsOp));
  }

  function renderPendingList(box, items) {
    box.hidden = items.length === 0;
    const schedule = items.length === 0 ? null : opsScheduleNote();
    const rows = [
      ...items.map((p) =>
        h(
          "div",
          { class: "pending-row" },
          h("span", { class: "tag pending", text: "pending" }),
          p.summary,
          muted(`· queued ${ago(p.queuedAt)}`),
          h("button", {
            text: "Forget",
            title: "Stop waiting for this result here. The change stays queued.",
            onclick: () => {
              pendingOps = pendingOps.filter((x) => x.id !== p.id);
              savePending();
              rerenderOps();
            },
          })
        )
      ),
    ];
    // One line under the list rather than one per row: every pending op is
    // waiting on the same next drain. Filtered, because replaceChildren renders
    // a null argument as the text "null".
    if (schedule) rows.push(schedule);
    box.replaceChildren(...rows);
  }

  /**
   * When the queued changes are expected to apply.
   *
   * projectedNextCheck says when: the scheduler's own next-run time
   * (`opsNextCheckAt`, passed in by scripts/check-and-publish.ps1, so at 18:10
   * it is tomorrow's 01:55, not 18:25), stepped forward by the measured
   * cadence once a quiet run has let it pass. Past the overdue allowance it
   * warns instead. Saying "applies at 11:40" forever would be a lie: the run
   * is late, or the task is outside its window or stopped.
   *
   * Market hours deliberately play no part. `ops pull` has no hours gate, so a
   * queued edit lands at the next check whether or not the market is open.
   */
  function opsScheduleNote() {
    const since = authExpiredSince();
    if (since !== null) {
      return h("div", {
        class: "note warn",
        text: `⚠ Waiting on the Schwab login, which expired ${ago(since)}. Queued changes keep their place and apply at the first check after it is renewed.`,
      });
    }
    const next = projectedNextCheck();
    if (next !== null) return h("div", { class: "note", text: `Applies at the next check, ${when(next)} (${until(next)}).` });
    const last = current?.opsProcessedThrough ?? null;
    if (last === null) return h("div", { class: "note", text: "Applied by the next scheduled check." });
    const interval = current?.opsIntervalMinutes ?? null;
    if (interval === null) {
      // Too few drains recorded to name a cadence; the watermark still says
      // whether anything is running at all.
      return h("div", { class: "note", text: `Applied by the next scheduled check. Last check ${ago(last)}.` });
    }
    if (!checkIsOverdue()) return h("div", { class: "note", text: "Applies at the next check, due now." });
    return h("div", {
      class: "note warn",
      text: `⚠ No check since ${when(last)} (${ago(last)}), and they run about every ${interval} min. The scheduled task may be outside its daily window or stopped — queued changes keep waiting until it runs.`,
    });
  }

  const field = (label, input) => h("label", { class: "field" }, h("span", { text: label }), input);
  const numberInput = (value, attrs = {}) => h("input", { type: "number", step: "any", min: "0", inputmode: "decimal", value: value ?? "", ...attrs });
  function directionSelect(value) {
    const select = h("select", {}, ...["up", "down", "either"].map((d) => h("option", { value: d, text: DIRECTION_LABEL[d] })));
    select.value = value ?? "up";
    return select;
  }
  // Page-side checks are only for quick feedback. The worker is the authority.
  const positive = (raw) => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
  };

  /** An optional number field: "" means unset, anything else must be positive. */
  const optionalPositive = (input) => (input.value.trim() === "" ? undefined : positive(input.value));

  // Worded once, because three forms ask for it and should not drift apart.
  const COVERED_SHARES_ERROR = "Shares covered must be above 0, or empty for all.";

  /**
   * The three fields every lot needs, checked in one order by both the add form
   * and the per-lot edit form. Returns the parsed values, or the first thing
   * wrong with them.
   */
  function readLotCore(shares, basis, date) {
    const count = positive(shares.value);
    if (count === null) return { error: "Enter shares above 0." };
    const basisPerShare = positive(basis.value);
    if (basisPerShare === null) return { error: "Enter a basis per share above 0." };
    if (!date.value) return { error: "Enter the purchase date." };
    return { count, basisPerShare, purchaseDate: date.value };
  }

  function renderAddForm() {
    const slot = $("alert-add");
    slot.hidden = !canEdit();
    if (!canEdit()) return;
    if (addFormEl) {
      if (!slot.contains(addFormEl)) slot.replaceChildren(addFormEl);
      return;
    }
    const symbol = h("input", { type: "text", placeholder: "GMED", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", maxlength: "16" });
    const level = numberInput(null, { placeholder: "80.50" });
    const direction = directionSelect("up");
    // The same three controls as the Edit form, so a new alert can carry an
    // absolute share count ("2.5M") and a window, not only a ratio - and so
    // both forms reject the same input with the same words.
    const volumeFields = buildVolumeFields(null);
    const error = h("span", { class: "form-error" });
    const button = h("button", { type: "submit", text: "Add alert" });
    addFormEl = h(
      "form",
      {
        class: "ops-form card",
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = "";
          const sym = symbol.value.trim().toUpperCase();
          const lvl = positive(level.value);
          if (!sym) return (error.textContent = "Enter a symbol.");
          if (lvl === null) return (error.textContent = "Enter a level above 0.");
          const read = volumeFields.read();
          if (read.error) return (error.textContent = read.error);
          const volume = read.volume;
          const params = { symbol: sym, level: lvl, direction: direction.value, ...(volume === null ? {} : volumeParams(volume)) };
          const summary =
            `add ${sym} ${DIRECTION_LABEL[direction.value].toLowerCase()} ${lvl}` +
            (volume === null ? "" : ` with volume ${volumeConditionText(volume)}`);
          button.disabled = true;
          const queued = await submitOp({ type: "alert.add", params }, { symbol: sym, summary });
          button.disabled = false;
          if (queued) {
            symbol.value = "";
            level.value = "";
            volumeFields.reset();
          }
        },
      },
      h("strong", { class: "form-title", text: "New price alert" }),
      field("Symbol", symbol),
      field("Level", level),
      field("Fires on", direction),
      ...volumeFields.fields,
      button,
      error,
      h("div", { class: "note", text: "Applied at the next scheduled check, against a live quote. A level at the current price is rejected." })
    );
    slot.replaceChildren(addFormEl);
  }

  /**
   * The Edit form for one alert. `revisitId` is set when the form is shown in
   * a trigger's details panel: the queued edit then also closes that queue
   * entry, because re-levelling from the panel is the decision it was waiting
   * on. It is part of the reuse key, so the same alert's form is rebuilt when
   * it is opened from the other drawer.
   */
  function editSection(a, revisitId = null) {
    if (!canEdit()) return null;
    const queued = pendingFor(a.id);
    const pending = queued.map((p) => h("p", { class: "note" }, h("span", { class: "tag pending", text: "pending" }), ` ${p.summary}, queued ${ago(p.queuedAt)}`));
    // The drawer is where a revisit-queue edit is made, so it is where "when
    // does this land?" gets asked first.
    if (queued.length > 0) pending.push(opsScheduleNote());
    if (a.kind !== "static" && a.kind !== "trailing" && a.kind !== "volume") {
      return [...pending, h("p", { class: "note", text: "This kind can't be edited from the page yet. Use alert edit in the CLI." })];
    }
    // Reuse the form while the alert is unchanged; rebuild it once an edit has landed.
    if (editForm?.alertId !== a.id || editForm.condition !== a.condition || editForm.revisitId !== revisitId) {
      editForm = { alertId: a.id, condition: a.condition, revisitId, el: buildEditForm(a, revisitId) };
    }
    // Any edit takes the alert's open fires off the queue (closeRevisitsForEdit
    // in the worker), wherever it is made. Say so before it happens.
    const open = (current?.revisitQueue ?? []).filter((r) => r.alertId === a.id).length;
    const closes =
      open === 0 ? null : h("p", { class: "note", text: `Saving an edit also takes ${open === 1 ? "this alert's open fire" : `this alert's ${open} open fires`} off the revisit queue.` });
    return [...pending, ...(closes ? [closes] : []), editForm.el];
  }

  const VOLUME_WINDOW_RE = /^\d+(\.\d+)?[smhd]$/;
  const sameVolume = (x, y) =>
    (x?.threshold ?? null) === (y?.threshold ?? null) &&
    (x?.ratio ?? null) === (y?.ratio ?? null) &&
    (x?.mode === "period" ? `${x.periodValue}${x.periodUnit}` : "") === (y?.mode === "period" ? `${y.periodValue}${y.periodUnit}` : "");
  const volumeConditionText = (v) =>
    `${v.ratio !== undefined ? `≥ ${v.ratio}x normal` : `≥ ${formatVolume(v.threshold)} shares`} ${v.mode === "period" ? `over ${v.periodValue}${v.periodUnit}` : "today"}`;

  /**
   * The Volume / Volume at least / Over controls, shared by the New alert form
   * and the Edit form so both offer the same choices and reject the same input.
   *
   * `existing` is the alert's current VolumeCondition, or null on a new alert.
   * `read()` returns { volume } - null meaning no condition - or { error }.
   */
  function buildVolumeFields(existing) {
    const kind = h(
      "select",
      {},
      h("option", { value: "none", text: "No volume condition" }),
      h("option", { value: "ratio", text: "× normal volume" }),
      h("option", { value: "shares", text: "Shares" })
    );
    kind.value = existing === null ? "none" : existing.ratio !== undefined ? "ratio" : "shares";
    // Text, not number: an <input type="number"> reports "" for "2.5M", so the
    // shorthand would be silently swallowed. Prefilled with volumeInputValue so
    // saving an untouched form sends back exactly the threshold it opened with.
    const amount = h("input", {
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      spellcheck: "false",
      value: existing === null ? "" : existing.ratio !== undefined ? String(existing.ratio) : volumeInputValue(existing.threshold),
    });
    // A select, not a free-text spec: the accepted shape ("30m", "2h") was
    // only ever stated in a placeholder, and the useful windows are a short
    // list. Values are the `Nunit` spec the worker takes, so read() is
    // unchanged and "" still means today.
    //
    // Nothing above four days appears in *sub-day* units on purpose. A
    // sub-day window fetches `ceil(days) + 1` days of 1-minute bars, and
    // Schwab's periodType=day only accepts 1-5 or 10 - so "120h" asks for 6
    // and fails on every check (see CLAUDE.md). Day-unit windows don't go
    // near that: getDailyBars asks for a date range, not a period count,
    // which is why 10 days is offered as "10d" and not as "240h".
    const WINDOW_OPTIONS = [
      ["", "Today"],
      ["15m", "Last 15 minutes"],
      ["30m", "Last 30 minutes"],
      ["1h", "Last hour"],
      ["2h", "Last 2 hours"],
      ["4h", "Last 4 hours"],
      ["1d", "Last day"],
      ["2d", "Last 2 days"],
      ["5d", "Last 5 days"],
      ["10d", "Last 10 days"],
    ];
    const current = existing?.mode === "period" ? `${existing.periodValue}${existing.periodUnit}` : "";
    const windowSelect = h("select", { class: "volume-window" }, ...WINDOW_OPTIONS.map(([value, text]) => h("option", { value, text })));
    // An alert set from the CLI can hold a window this list doesn't offer
    // ("45s"). Keep it rather than snapping it to Today, which would be an
    // edit nobody asked for on a form opened only to read.
    if (current !== "" && !WINDOW_OPTIONS.some(([value]) => value === current)) {
      windowSelect.append(h("option", { value: current, text: `Last ${current}` }));
    }
    windowSelect.value = current;
    const PLACEHOLDER = { ratio: "e.g. 1.5", shares: "e.g. 2.5M", none: "" };
    const sync = () => {
      amount.placeholder = PLACEHOLDER[kind.value];
      amount.disabled = kind.value === "none";
      windowSelect.disabled = kind.value === "none";
    };
    kind.addEventListener("change", sync);
    sync();

    const read = () => {
      if (kind.value === "none") return { volume: null };
      // Shares take the K/M/B shorthand; a ratio is a bare multiple, where a
      // suffix would mean nothing ("1.5M x normal volume").
      const isRatio = kind.value === "ratio";
      const value = isRatio ? positive(amount.value) : parseVolume(amount.value);
      if (value === null) {
        return { error: isRatio ? "Enter a multiple above 0, e.g. 1.5." : "Enter a share count above 0, e.g. 2.5M." };
      }
      // Still checked, because a window preserved off an alert reaches here
      // as an option value the page didn't author.
      const win = windowSelect.value.trim().toLowerCase();
      if (win !== "" && win !== "today" && !VOLUME_WINDOW_RE.test(win)) {
        return { error: 'Volume window: leave empty for today, or e.g. "30m", "2h", "1d".' };
      }
      const period = win === "" || win === "today" ? null : { periodValue: Number(win.slice(0, -1)), periodUnit: win.slice(-1) };
      return {
        volume: { ...(isRatio ? { ratio: value } : { threshold: value }), ...(period ? { mode: "period", ...period } : { mode: "today" }) },
      };
    };

    const reset = () => {
      kind.value = "none";
      amount.value = "";
      windowSelect.value = "";
      sync();
    };

    return { fields: [field("Volume", kind), field("Volume at least", amount), field("Over", windowSelect)], read, reset };
  }

  /** An op's volume params, from what buildVolumeFields read. */
  function volumeParams(volume) {
    const params = volume.ratio !== undefined ? { volumeRatio: volume.ratio } : { volumeAtLeast: volume.threshold };
    if (volume.mode === "period") params.volumePeriod = `${volume.periodValue}${volume.periodUnit}`;
    return params;
  }

  /**
   * One form for price and volume whatever the alert is now (the user's call,
   * 2026-09-18): a static or volume alert shows both a level and a volume
   * condition, so volume can be added to a price alert and a price level to a
   * volume alert. Leaving the level empty makes a volume-only alert; the
   * worker (editAlert) does the conversion, keeping the id and history. A
   * trailing alert shows its trail in place of the level.
   */
  function buildEditForm(a, revisitId = null) {
    const error = h("span", { class: "form-error" });
    const button = h("button", { type: "submit", text: "Queue edit" });
    const fields = [];
    const hasLevel = a.kind === "static" || a.kind === "volume";

    const level = numberInput(a.kind === "static" ? a.level : null, { placeholder: a.kind === "volume" ? "none" : "" });
    const direction = directionSelect(a.direction);
    const trailType = h("select", {}, h("option", { value: "percent", text: "Percent" }), h("option", { value: "amount", text: "Dollars" }));
    const trailValue = numberInput(null, { placeholder: "unchanged" });
    if (hasLevel) fields.push(field("Level", level), field("Fires on", direction));
    else fields.push(field("Trail by", trailType), field("Distance", trailValue));

    const old = a.volume ?? null;
    const volumeFields = buildVolumeFields(old);
    fields.push(...volumeFields.fields);

    const collect = () => {
      const params = {};
      const changes = [];

      const read = volumeFields.read();
      if (read.error) return { error: read.error };
      const volume = read.volume;

      if (hasLevel) {
        const raw = level.value.trim();
        const lvl = raw === "" ? null : positive(raw);
        if (raw !== "" && lvl === null) return { error: "Enter a level above 0, or leave it empty for a volume-only alert." };
        if (lvl === null && volume === null) return { error: "Set a level, a volume condition, or both." };
        const was = a.kind === "static" ? a.level : null;
        if (lvl === null && was !== null) {
          params.clearLevel = true;
          changes.push(`drop level ${was}`);
        } else if (lvl !== null && lvl !== was) {
          params.level = lvl;
          changes.push(was === null ? `add level ${lvl}` : `level ${was} → ${lvl}`);
        }
        // A volume alert gaining a level states its direction outright: it
        // has none yet, so "unchanged" would mean the worker's default.
        if (lvl !== null && (a.kind === "volume" || direction.value !== a.direction)) {
          params.direction = direction.value;
          changes.push(a.kind === "volume" ? DIRECTION_LABEL[direction.value].toLowerCase() : `${DIRECTION_LABEL[a.direction].toLowerCase()} → ${DIRECTION_LABEL[direction.value].toLowerCase()}`);
        }
      } else if (trailValue.value.trim() !== "") {
        const v = positive(trailValue.value);
        if (v === null) return { error: "Enter a trail distance above 0, or leave it empty." };
        Object.assign(params, trailType.value === "percent" ? { trailPercent: v } : { trailAmount: v });
        changes.push(`trail ${trailType.value === "percent" ? `${v}%` : `$${v}`}`);
      }

      if (volume === null && old !== null) {
        params.clearVolume = true;
        changes.push(`drop volume ${volumeConditionText(old)}`);
      } else if (volume !== null && !sameVolume(volume, old)) {
        Object.assign(params, volumeParams(volume));
        changes.push(`volume ${volumeConditionText(volume)}`);
      }
      return { params, changes };
    };
    return h(
      "form",
      {
        class: "ops-form card",
        style: "margin-top:1.25rem",
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = "";
          const c = collect();
          if (c.error) return (error.textContent = c.error);
          if (c.changes.length === 0) return (error.textContent = "Nothing changed.");
          button.disabled = true;
          await submitOp(
            {
              type: "alert.edit",
              target: revisitId === null ? { alertId: a.id } : { alertId: a.id, revisitId },
              expect: { condition: a.condition },
              params: c.params,
            },
            {
              symbol: a.symbol,
              alertId: a.id,
              summary: `edit ${a.symbol} ${c.changes.join(", ")}`,
            }
          );
          button.disabled = false;
        },
      },
      h("strong", { class: "form-title", text: revisitId === null ? "Edit" : "Edit this alert" }),
      ...fields,
      button,
      error,
      h("div", {
        class: "note",
        text:
          revisitId === null
            ? "Applied at the next scheduled check. Rejected if the alert changes before then."
            : "Applied at the next scheduled check, which also drops this entry from the revisit queue. Rejected if the alert changes before then.",
      })
    );
  }

  // ---- holdings (unlocked) ----------------------------------------------------
  //
  // Holdings are never readable on the public site. With editing unlocked they
  // come from vault.json, encrypted under the ops token (src/web/vault.ts). The
  // key derivation here must match vaultKey there. A token that can't open the
  // vault is the wrong token, which the page learns before sending anything.

  const VAULT_KEY_CONTEXT = "equity-watch/holdings-vault/v1 ";
  let vaultData = null; // { holdings, lots, stops }
  let vaultError = null;
  let vaultLoading = null;
  const expandedPositions = new Set();
  // Built once per symbol and reused while its lots and stops are unchanged, so a poll doesn't wipe what's typed.
  const detailCache = new Map(); // symbol -> { sig, el }
  let lotAddFormEl = null;

  const isHoldingsOp = (p) => !p.type.startsWith("alert.") && !p.type.startsWith("revisit.");
  const canEditHoldings = () => canEdit() && vaultData !== null;
  const localToday = () => new Date().toLocaleDateString("en-CA");
  const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function holdingRows() {
    if (vaultData) return vaultData.holdings;
    return current?.site?.holdings === true ? current.holdings : null;
  }

  async function openVault(token) {
    const resp = await fetch("vault.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const doc = await resp.json();
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VAULT_KEY_CONTEXT + token));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(doc.iv) }, key, fromBase64(doc.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function refreshVault() {
    if (!canEdit() || current?.site?.vault !== true) {
      vaultData = null;
      return Promise.resolve();
    }
    if (vaultLoading) return vaultLoading;
    const token = opsToken;
    vaultLoading = openVault(token)
      .then((data) => {
        if (opsToken !== token) return;
        vaultData = data;
        vaultError = null;
      })
      .catch((err) => {
        if (opsToken !== token) return;
        if (err.name === "OperationError") {
          // AES-GCM authentication failed: the vault wasn't sealed with this token.
          notice("That token didn't open the holdings, so it isn't the current ops token. Unlock again with the right one.", false);
          vaultLoading = null;
          setToken(null);
        } else {
          vaultError = `Couldn't load holdings (${err.message}).`;
        }
      })
      .finally(() => {
        vaultLoading = null;
        rerenderOps();
      });
    return vaultLoading;
  }

  function renderHoldingsView() {
    const rows = holdingRows();
    $("nav-holdings").hidden = rows === null;
    $("nav-holdings-count").textContent = rows === null ? "" : `(${rows.length})`;
    const status = $("holdings-status");
    if (rows === null) {
      status.textContent =
        vaultError ??
        (vaultLoading ? "Loading holdings…" : opsEnabled() && current?.site?.vault ? "Holdings are private. Unlock editing to see and change them." : "Holdings aren't published.");
    } else {
      // A held tag can point at a symbol that is no longer a position (the tag
      // rides on a trigger recorded when it was), so say so rather than
      // highlighting nothing.
      const missing = focusedHolding !== null && !rows.some((r) => r.symbol === focusedHolding);
      status.textContent = current
        ? `Prices as of ${ago(current.generatedAt)}.${canEditHoldings() ? " Select a position for its lots and stops." : ""}${
            missing ? ` ${focusedHolding} isn't a position here.` : ""
          }`
        : "";
    }
    renderLotAddForm();
    renderPending();
    if (rows === null) {
      $("holdings").replaceChildren();
      $("holdings-count").textContent = "";
      $("holdings-toolbar").hidden = true;
      return;
    }
    renderHoldings(rows);
  }

  // A destructive action takes a second click within a few seconds, rather than a modal.
  function confirmButton(label, action) {
    let armed = false;
    let timer = null;
    const reset = () => {
      armed = false;
      btn.textContent = label;
      btn.classList.remove("danger");
    };
    const btn = h("button", {
      type: "button",
      text: label,
      onclick: (e) => {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          btn.textContent = "Click again to confirm";
          btn.classList.add("danger");
          timer = setTimeout(reset, 4000);
          return;
        }
        clearTimeout(timer);
        reset();
        action();
      },
    });
    return btn;
  }

  function refreshAccountList() {
    const list = $("account-options");
    if (!list || !vaultData) return;
    const accounts = [...new Set(vaultData.lots.map((l) => l.account).filter(Boolean))].sort();
    list.replaceChildren(...accounts.map((a) => h("option", { value: a })));
  }

  function renderLotAddForm() {
    const slot = $("lot-add");
    slot.hidden = !canEditHoldings();
    if (slot.hidden) return;
    if (lotAddFormEl) {
      if (!slot.contains(lotAddFormEl)) slot.replaceChildren(lotAddFormEl);
      refreshAccountList();
      return;
    }
    const symbol = h("input", { type: "text", placeholder: "AAPL", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", maxlength: "16" });
    const shares = numberInput(null, { placeholder: "10" });
    const basis = numberInput(null, { placeholder: "per share" });
    const date = h("input", { type: "date", value: localToday() });
    const account = h("input", { type: "text", list: "account-options", placeholder: "optional", maxlength: "40" });
    const stopPrice = numberInput(null, { placeholder: "optional" });
    const stopCovered = numberInput(null, { placeholder: "all" });
    const error = h("span", { class: "form-error" });
    const button = h("button", { type: "submit", text: "Add lot" });
    lotAddFormEl = h(
      "form",
      {
        class: "ops-form card",
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = "";
          const sym = symbol.value.trim().toUpperCase();
          if (!sym) return (error.textContent = "Enter a symbol.");
          const entered = readLotCore(shares, basis, date);
          if (entered.error) return (error.textContent = entered.error);
          const n = entered.count;
          const b = entered.basisPerShare;
          // The stop is optional here and required in stopsBlock, so the two
          // wordings differ on purpose.
          const sp = optionalPositive(stopPrice);
          if (sp === null) return (error.textContent = "Stop price must be above 0, or empty for none.");
          const sc = optionalPositive(stopCovered);
          if (sc === null) return (error.textContent = COVERED_SHARES_ERROR);
          const acct = account.value.trim();
          const params = {
            symbol: sym,
            count: n,
            basisPerShare: b,
            purchaseDate: date.value,
            ...(acct ? { account: acct } : {}),
            ...(sp !== undefined ? { stopPrice: sp } : {}),
            ...(sc !== undefined ? { stopCount: sc } : {}),
          };
          const alreadyHeld = vaultData?.lots.some((l) => l.symbol === sym) ?? false;
          const stopNote = sp === undefined ? "" : alreadyHeld ? `, replacing its stop with ${sp}` : `, stop ${sp}`;
          button.disabled = true;
          const queued = await submitOp({ type: "lot.add", params }, { symbol: sym, summary: `add ${n} ${sym} @ ${b}${stopNote}` });
          button.disabled = false;
          if (queued) {
            symbol.value = "";
            shares.value = "";
            basis.value = "";
            stopPrice.value = "";
            stopCovered.value = "";
          }
        },
      },
      h("strong", { class: "form-title", text: "Add a lot" }),
      field("Symbol", symbol),
      field("Shares", shares),
      field("Basis / share", basis),
      field("Purchased", date),
      field("Account", account),
      field("Stop price", stopPrice),
      field("Stop shares covered", stopCovered),
      button,
      error,
      h("datalist", { id: "account-options" }),
      h("div", {
        class: "note",
        text: "Applied at the next scheduled check. Basis stays blended across a symbol's lots. A stop set here replaces any existing stop on this symbol.",
      })
    );
    slot.replaceChildren(lotAddFormEl);
    refreshAccountList();
  }

  const lotExpect = (lot) => ({ count: lot.count, basisPerShare: lot.basisPerShare, purchaseDate: lot.purchaseDate, account: lot.account ?? null });

  function lotRows(lot) {
    const count = numberInput(lot.count);
    const basis = numberInput(lot.basisPerShare);
    const date = h("input", { type: "date", value: lot.purchaseDate });
    const account = h("input", { type: "text", list: "account-options", value: lot.account ?? "", maxlength: "40" });
    const error = h("span", { class: "form-error" });
    const form = h(
      "form",
      {
        class: "ops-form",
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = "";
          const entered = readLotCore(count, basis, date);
          if (entered.error) return (error.textContent = entered.error);
          const n = entered.count;
          const b = entered.basisPerShare;
          const params = {};
          const changes = [];
          if (n !== lot.count) {
            params.count = n;
            changes.push(`shares ${lot.count} → ${n}`);
          }
          if (b !== lot.basisPerShare) {
            params.basisPerShare = b;
            changes.push(`basis ${lot.basisPerShare} → ${b}`);
          }
          if (date.value !== lot.purchaseDate) {
            params.purchaseDate = date.value;
            changes.push(`purchased ${date.value}`);
          }
          const acct = account.value.trim();
          if (acct !== (lot.account ?? "")) {
            // An empty account clears the label.
            params.account = acct;
            changes.push(acct ? `account ${acct}` : "no account");
          }
          if (changes.length === 0) return (error.textContent = "Nothing changed.");
          await submitOp(
            { type: "lot.edit", target: { lotId: lot.id }, expect: lotExpect(lot), params },
            { symbol: lot.symbol, summary: `edit ${lot.symbol} lot: ${changes.join(", ")}` }
          );
        },
      },
      field("Shares", count),
      field("Basis / share", basis),
      field("Purchased", date),
      field("Account", account),
      h("button", { type: "submit", text: "Queue edit" }),
      error
    );
    const formRow = h("tr", { class: "lot-edit", hidden: true }, h("td", { colspan: "5" }, form));
    const row = h(
      "tr",
      {},
      h("td", { text: lot.count }),
      h("td", { text: money(lot.basisPerShare) }),
      h("td", { text: lot.purchaseDate }),
      h("td", { text: lot.account ?? "–" }),
      h(
        "td",
        {},
        h(
          "span",
          { class: "row-actions" },
          h("button", {
            type: "button",
            text: "Edit",
            onclick: (e) => {
              e.stopPropagation();
              formRow.hidden = !formRow.hidden;
            },
          }),
          confirmButton("Remove", () =>
            submitOp(
              { type: "lot.remove", target: { lotId: lot.id }, expect: lotExpect(lot), params: {} },
              { symbol: lot.symbol, summary: `remove a ${lot.symbol} lot (${lot.count} @ ${lot.basisPerShare})` }
            )
          )
        )
      )
    );
    return [row, formRow];
  }

  function stopsBlock(symbol, stops) {
    const price = numberInput(null, { placeholder: "price" });
    const covered = numberInput(null, { placeholder: "all" });
    const error = h("span", { class: "form-error" });
    return h(
      "div",
      { class: "stops" },
      h(
        "div",
        { class: "stop-list" },
        h("span", { class: "muted", text: stops.length ? "Stops:" : "No stops." }),
        ...stops.map((s) =>
          h(
            "span",
            { class: "tag stop-tag" },
            `${money(s.stopPrice)} · ${s.count ?? "all"} shares`,
            confirmButton("Remove", () =>
              submitOp(
                { type: "stop.remove", target: { stopId: s.id }, expect: { stopPrice: s.stopPrice }, params: {} },
                { symbol, summary: `remove ${symbol} stop at ${s.stopPrice}` }
              )
            )
          )
        )
      ),
      h(
        "form",
        {
          class: "ops-form",
          onsubmit: async (e) => {
            e.preventDefault();
            error.textContent = "";
            const p = positive(price.value);
            const c = optionalPositive(covered);
            if (p === null) return (error.textContent = "Enter a stop price above 0.");
            if (c === null) return (error.textContent = COVERED_SHARES_ERROR);
            const queued = await submitOp(
              { type: "stop.add", params: { symbol, stopPrice: p, ...(c !== undefined ? { count: c } : {}) } },
              { symbol, summary: `add ${symbol} stop at ${p}${c !== undefined ? ` for ${c} shares` : ""}` }
            );
            if (queued) {
              price.value = "";
              covered.value = "";
            }
          },
        },
        field("Stop price", price),
        field("Shares covered", covered),
        h("button", { type: "submit", text: "Add stop" }),
        error,
        h("div", { class: "note", text: "Stops are records only; nothing watches them yet." })
      )
    );
  }

  function positionDetail(symbol) {
    const lots = vaultData.lots.filter((l) => l.symbol === symbol);
    const stops = vaultData.stops.filter((s) => s.symbol === symbol);
    const sig = JSON.stringify([lots, stops]);
    const cached = detailCache.get(symbol);
    if (cached?.sig === sig) return cached.el;
    const el = h(
      "div",
      { class: "position-detail" },
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "lots" },
          h("thead", {}, h("tr", {}, ...["Shares", "Basis / share", "Purchased", "Account", ""].map((t) => h("th", { text: t })))),
          h("tbody", {}, ...lots.flatMap(lotRows))
        )
      ),
      stopsBlock(symbol, stops),
      h(
        "div",
        { class: "actions" },
        confirmButton(`Remove the ${symbol} position`, () =>
          submitOp(
            { type: "position.remove", target: { symbol }, expect: { lotIds: lots.map((l) => l.id) }, params: {} },
            { symbol, summary: `remove the ${symbol} position` }
          )
        )
      )
    );
    detailCache.set(symbol, { sig, el });
    return el;
  }

  // ---- state ----------------------------------------------------------------

  let current = null; // dashboard.json
  let alertsDoc = null; // alerts.json
  let alertsPromise = null;
  let freshIds = new Set();
  let holdingsSort = { key: "pctFromBasis", dir: -1 };
  // The position #/holdings/<symbol> points at, and whether it still needs
  // scrolling into view (once per arrival, not on every poll's re-render).
  let focusedHolding = null;
  let scrollToFocused = false;
  // "all", an account label, or UNLABELED_ACCOUNT for positions whose lots name none.
  let holdingsAccount = "all";
  let baseView = "overview";
  let openDrawerKey = null;
  const alertsFilter = { q: "", kind: "all", sort: "symbol" };

  // ---- overview -------------------------------------------------------------

  function renderTiles(s, showHoldings) {
    const tile = (value, label) => h("div", { class: "tile" }, h("div", { class: "value", text: value }), h("div", { class: "label", text: label }));
    const tiles = [
      tile(s.openRevisits, `open revisits · ${s.actionableRevisits} with a proposed level`),
      tile(s.triggersInWindow, `triggers in the last ${s.windowDays} days`),
      tile(s.liveAlerts, `live alerts on ${s.symbolsWatched} symbols`),
    ];
    // replaceChildren renders a null argument as the text "null", so omit rather than pass it.
    if (showHoldings) tiles.push(tile(s.positions, "positions held"));
    $("tiles").replaceChildren(...tiles);
  }

  /**
   * The position behind a held row, for the queue.
   *
   * Assembled here out of holdingRows() rather than read off RevisitRow, for
   * the reason the details drawer's Position row is: share counts, basis and
   * value may not travel in a published document. On the public page
   * holdingRows() is null and this is simply absent, leaving the `held` tag,
   * which is the one holdings fact a document may carry.
   */
  /**
   * The held row for a symbol, or null.
   *
   * The single place the privacy rule is applied: holdingRows() is null on a
   * public page, so every caller is absent there rather than each remembering
   * to check. Never read a position off a TriggerRow or AlertRow - those travel
   * in dashboard.json, and only `heldPosition` may.
   */
  function holdingFor(symbol) {
    if (!symbol) return null;
    const rows = holdingRows();
    return rows === null ? null : (rows.find((x) => x.symbol === symbol) ?? null);
  }

  /** How the position is doing, the part both renderings word identically. */
  const performanceParts = (r) =>
    [r.pctFromBasis !== null ? `${pct(r.pctFromBasis)} vs basis` : null, r.marketValue !== null ? `value ${money(r.marketValue)}` : null].filter(Boolean);

  function positionNote(symbol) {
    const r = holdingFor(symbol);
    if (!r) return null;
    const parts = [
      `Holding ${r.shares} @ ${money(r.basis)}`,
      ...performanceParts(r),
      r.stops.length ? `stop ${r.stops.map(money).join(", ")}` : null,
    ].filter(Boolean);
    return h("div", { class: "sub position-note", text: parts.join(" · ") });
  }

  function renderQueue(rows) {
    $("queue-count").textContent = rows.length ? `(${rows.length})` : "";
    if (rows.length === 0) {
      $("queue").replaceChildren(h("div", { class: "empty", text: "Nothing waiting on a decision." }));
      return;
    }
    $("queue").replaceChildren(
      ...rows.map((r) =>
        h(
          "div",
          { class: "queue-row" },
          h("div", { class: `priority${r.priority === null ? " none" : ""}`, text: r.priority === null ? "–" : r.priority.toFixed(0) }),
          h(
            "div",
            {},
            h(
              "div",
              { class: "headline" },
              symbolLink(r.symbol, r.chartUrl),
              " ",
              h("a", { class: "plain", href: triggerHash(r.id), text: bareHeadline(r) }),
              heldTag(r),
              reversedTag(r),
              // A queued edit from the details panel closes this entry, but not
              // until the next check runs; say so rather than leave the row
              // looking like nothing happened.
              pendingTag(r.alertId),
              dismissPending(r.id) ? h("span", { class: "tag pending", text: "dismiss pending" }) : null
            ),
            h(
              "div",
              { class: "sub" },
              `Fired ${r.direction ? `${SIDE_OF[r.direction]} ` : ""}${r.levelAtTrigger ?? "–"} @ ${money(r.triggerPrice)} · ${when(r.triggeredAt)}`,
              r.session && r.session !== "regular" && SESSION_LABEL[r.session] ? ` · ${SESSION_LABEL[r.session]}` : "",
              r.action ? `. ${r.action}` : ""
            ),
            r.reversal ? h("div", { class: "sub reversal-note", text: `Reversed: ${reversalText(r)}` }) : null,
            // What has changed since this fire joined the queue. Read straight
            // off the document: the builder writes the sentence, the page only
            // decides it goes here (src/narrative.ts's rule).
            ...(r.updates ?? []).map((text) => h("div", { class: "sub update-note", text })),
            r.sinceTrigger ? h("div", { class: "sub", text: r.sinceTrigger }) : null,
            positionNote(r.symbol),
            r.sinceWatching ? h("div", { class: "sub", text: r.sinceWatching }) : null,
            r.why ? h("div", { class: "why", text: r.why }) : null,
            h(
              "div",
              { class: "actions" },
              h("a", { href: triggerHash(r.id), text: "Details" }),
              h("a", { href: r.chartUrl, target: CHART_TARGET, text: "Chart" }),
              r.suggestedLevel !== null ? copyButton(`Copy apply → ${r.suggestedLevel}`, `${CLI} alert revisit apply ${r.id}`) : null,
              dismissButton(r)
            )
          )
        )
      )
    );
  }

  /**
   * Takes this one fire off the queue and nothing else. It lives on the queue
   * row rather than in the trigger panel so what it removes is plain: the row
   * it sits on. The alert keeps its level and keeps watching, and its next
   * fire comes back here as a new entry.
   */
  function dismissButton(r) {
    if (!canEdit() || dismissPending(r.id)) return null;
    const btn = confirmButton("Dismiss", () =>
      submitOp(
        { type: "revisit.dismiss", target: { revisitId: r.id, alertId: r.alertId }, params: {} },
        { symbol: r.symbol, alertId: r.alertId, revisitId: r.id, summary: `${r.symbol}: dismiss the ${when(r.triggeredAt)} fire${r.levelAtTrigger === null ? "" : ` at ${r.levelAtTrigger}`} from the queue` }
      )
    );
    btn.title = "Remove this fire from the queue. The alert is not changed: it keeps its level, keeps watching, and its next fire comes back here.";
    return btn;
  }

  // A div rather than an <a>: the ticker inside is its own link, and links can't nest.
  function triggerRow(t) {
    const open = () => (location.hash = triggerHash(t.id));
    return h(
      "div",
      {
        class: `trigger-row clickable${freshIds.has(t.id) ? " new" : ""}`,
        role: "link",
        tabindex: "0",
        onclick: open,
        onkeydown: (e) => {
          if (e.key === "Enter") open();
        },
      },
      h("span", { class: "when", text: when(t.triggeredAt) }),
      h("span", {}, symbolLink(t.symbol, t.chartUrl), " ", bareHeadline(t), heldTag(t), reversedTag(t, true)),
      h("span", { class: "status", text: t.status })
    );
  }

  function renderTriggers(rows, windowDays) {
    $("triggers-count").textContent = rows.length ? `(${rows.length})` : "";
    if (rows.length === 0) {
      $("triggers").replaceChildren(
        h("div", { class: "empty", text: `Nothing has fired in the last ${windowDays} days, and nothing is waiting on a decision.` })
      );
      return;
    }
    $("triggers").replaceChildren(...rows.map(triggerRow));
  }

  function renderStories(stories) {
    $("stories-count").textContent = stories.length ? `(${stories.length})` : "";
    if (stories.length === 0) {
      $("stories").replaceChildren(h("div", { class: "empty", text: "No symbol has fired more than once yet." }));
      return;
    }
    $("stories").replaceChildren(
      ...stories.map((s) =>
        h("div", { class: "story" }, h("div", { class: "headline" }, ...linkLeadingSymbol(s.summary, s.symbol)), h("ol", {}, ...s.lines.map((l) => h("li", { text: l.text }))))
      )
    );
  }

  const HOLDING_COLS = [
    { key: "symbol", label: "Symbol" },
    { key: "accounts", label: "Account" },
    { key: "shares", label: "Shares" },
    { key: "basis", label: "Basis" },
    { key: "price", label: "Price" },
    { key: "pctFromBasis", label: "vs basis" },
    { key: "bar", label: "", sortable: false },
    { key: "marketValue", label: "Value" },
  ];

  // Documents published before HoldingRow carried accounts have no such key.
  const accountsOf = (r) => r.accounts ?? [];
  const UNLABELED_ACCOUNT = "__none";

  /** A position is in an account if any of its lots is; unlabeled ones are their own bucket. */
  function inAccountFilter(r) {
    if (holdingsAccount === "all") return true;
    const accounts = accountsOf(r);
    if (holdingsAccount === UNLABELED_ACCOUNT) return accounts.length === 0;
    return accounts.includes(holdingsAccount);
  }

  /** Sorting by Account uses what the cell reads; no labels sort last, as nulls do. */
  const holdingSortValue = (r, key) => (key === "accounts" ? accountsOf(r).join(", ") || null : r[key]);

  /**
   * The choices come from the rows themselves, so a renamed or emptied account
   * disappears on the next poll. Counts are of positions, not lots, and a
   * symbol held in two accounts is counted under both.
   */
  function renderAccountFilter(rows) {
    const counts = new Map();
    let unlabeled = 0;
    for (const r of rows) {
      const accounts = accountsOf(r);
      if (accounts.length === 0) unlabeled++;
      for (const a of accounts) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const options = [...counts.keys()].sort().map((a) => ({ value: a, text: `${a} (${counts.get(a)})` }));
    if (unlabeled) options.push({ value: UNLABELED_ACCOUNT, text: `No account (${unlabeled})` });
    // One bucket is nothing to choose between, so the filter stays out of the way.
    $("holdings-toolbar").hidden = options.length < 2;
    // Drop a selection whose account is gone, or the table would render empty
    // with no way to see why.
    if (holdingsAccount !== "all" && !options.some((o) => o.value === holdingsAccount)) holdingsAccount = "all";
    const select = $("holdings-account");
    select.replaceChildren(h("option", { value: "all", text: `All accounts (${rows.length})` }), ...options.map((o) => h("option", o)));
    select.value = holdingsAccount;
  }

  function renderHoldings(rows) {
    renderAccountFilter(rows);
    const shown = rows.filter(inAccountFilter);
    // Say "3 of 12" while a filter hides some, so a short list never reads as the whole book.
    $("holdings-count").textContent = shown.length === rows.length ? (rows.length ? `(${rows.length})` : "") : `(${shown.length} of ${rows.length})`;
    const { key, dir } = holdingsSort;
    const sorted = [...shown].sort((a, b) => {
      const av = holdingSortValue(a, key);
      const bv = holdingSortValue(b, key);
      if (av === null) return 1;
      if (bv === null) return -1;
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * dir;
    });
    // Scale bars to the largest move shown, capped so one outlier can't flatten
    // the rest. Measured over the filtered set: a hidden row must not set the scale.
    const span = Math.min(50, Math.max(5, ...shown.map((r) => Math.abs(r.pctFromBasis ?? 0))));
    const editable = canEditHoldings();
    const pendingSymbols = new Set(pendingOps.filter(isHoldingsOp).map((p) => p.symbol));

    const head = h(
      "tr",
      {},
      ...HOLDING_COLS.map((c) =>
        h("th", {
          text: c.label,
          "aria-sort": c.key === key ? (dir > 0 ? "ascending" : "descending") : null,
          onclick:
            c.sortable === false
              ? null
              : () => {
                  holdingsSort = { key: c.key, dir: c.key === key ? -dir : c.key === "symbol" ? 1 : -1 };
                  renderHoldings(rows);
                },
        })
      )
    );

    const body = sorted.flatMap((r) => {
      const p = r.pctFromBasis;
      const width = p === null ? 0 : (Math.min(Math.abs(p), span) / span) * 50;
      const open = editable && expandedPositions.has(r.symbol);
      const toggle = () => {
        if (expandedPositions.has(r.symbol)) expandedPositions.delete(r.symbol);
        else expandedPositions.add(r.symbol);
        renderHoldings(rows);
      };
      const focused = r.symbol === focusedHolding;
      const row = h(
        "tr",
        {
          class: [r.ignored ? "ignored" : "", editable ? "clickable" : "", focused ? "focused" : ""].filter(Boolean).join(" ") || null,
          title: r.ignored ? "Not alerted (ignoreSymbols)" : null,
          tabindex: editable ? "0" : null,
          "aria-expanded": editable ? String(open) : null,
          onclick: editable ? toggle : null,
          onkeydown: editable
            ? (e) => {
                if (e.key === "Enter") toggle();
              }
            : null,
        },
        h(
          "td",
          {},
          symbolLink(r.symbol),
          r.stops.length ? h("span", { class: "tag", text: `stop ${r.stops.join(", ")}` }) : null,
          pendingSymbols.has(r.symbol) ? h("span", { class: "tag pending", text: "change pending" }) : null
        ),
        h("td", { text: accountsOf(r).join(", ") || "—" }),
        h("td", { text: r.shares }),
        h("td", { text: money(r.basis) }),
        h("td", { text: money(r.price) }),
        h("td", { text: pct(p) }),
        h("td", { class: "bar-cell" }, h("div", { class: "bar" }, p ? h("span", { class: p > 0 ? "up" : "down", style: `width:${width}%` }) : null)),
        h("td", { text: money(r.marketValue) })
      );
      if (focused && scrollToFocused) {
        scrollToFocused = false;
        // After this batch is in the document, not while it is still detached.
        requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
      }
      return open ? [row, h("tr", { class: "detail-row" }, h("td", { colspan: String(HOLDING_COLS.length) }, positionDetail(r.symbol)))] : [row];
    });
    if (body.length === 0) {
      body.push(h("tr", {}, h("td", { class: "empty", colspan: String(HOLDING_COLS.length), text: "No positions." })));
    }
    $("holdings").replaceChildren(h("thead", {}, head), h("tbody", {}, ...body));
  }

  function renderQuiet(notes, total) {
    $("quiet-section").hidden = notes.length === 0;
    $("quiet-summary").textContent = `${total} watched a while with nothing since${total > notes.length ? ` (showing ${notes.length})` : ""}`;
    // Notes are plain strings that open with "SYMBOL:" (quietWatchNote).
    $("quiet").replaceChildren(...notes.map((n) => h("li", {}, ...linkLeadingSymbol(n, n.match(/^([^\s:]+):/)?.[1]))));
  }

  /**
   * The one thing on this page that asks the reader to go and do something.
   * Nothing here is recoverable from the browser: the queue is on SQS and the
   * login lives on the machine that drains it, so the banner names the command
   * rather than offering a button that could not work (see the header of
   * src/ops/pull.ts on why nothing can push to the machine).
   */
  function renderAuthBanner() {
    const since = authExpiredSince();
    const el = $("auth-banner");
    el.hidden = since === null;
    if (since === null) return;
    el.replaceChildren(
      h("strong", { text: "⚠ Schwab login expired" }),
      document.createTextNode(` ${ago(since)}. Checks are paused and queued changes are waiting.`),
      h(
        "span",
        { class: "auth-detail" },
        "Schwab refresh tokens last 7 days and only a browser sign-in renews one. Run ",
        h("code", { text: "node dist/cli.js schwab-login" }),
        " on the machine that runs the checks; queued changes apply at the next check after that."
      )
    );
  }

  function renderUpdated() {
    if (!current) return;
    const el = $("updated");
    // The next check belongs here, not only on a pending change: "when does
    // this refresh?" is asked whether or not anything is queued, and the age
    // alone can't answer it - a quiet run publishes nothing, so a document an
    // hour old is normal rather than a sign the checker stopped.
    const next = nextCheckText();
    el.textContent = `Updated ${ago(current.generatedAt)}${next === null ? "" : ` · ${next}`}`;
    el.classList.toggle("stale", authExpiredSince() !== null || (next !== null && checkIsOverdue()));
    el.title = `Document built ${new Date(current.generatedAt).toLocaleString()}`;
  }

  /**
   * "next check 1:55 AM" for the header, or null when nothing published says.
   * Same source as the note on a pending change: projectedNextCheck, then the
   * age of the last drain when even that can't be projected.
   */
  function nextCheckText() {
    // A next check is coming, but it will not check anything, so do not name a
    // time. The banner carries the detail; this is the one-line version.
    if (authExpiredSince() !== null) return "checks paused, login expired";
    const next = projectedNextCheck();
    if (next !== null) return `next check ${when(next)}`;
    const last = current?.opsProcessedThrough ?? null;
    if (last === null || (current?.opsIntervalMinutes ?? null) === null) return null;
    return checkIsOverdue() ? `no check since ${when(last)}` : "next check due now";
  }

  /**
   * When the next check should run, as an ISO string, or null when that can't
   * be said honestly (nothing published a schedule, or the run is late).
   *
   * The scheduler's own `opsNextCheckAt` while it is still ahead; with none,
   * one cadence after the last drain. When the publisher skips quiet runs
   * (`opsMaxStaleMinutes`), a time that has passed usually means a run
   * happened and published nothing, so step it forward by the cadence - the
   * task repeats on a fixed grid, and the run ending its daily window always
   * publishes (shouldPublish), so stepping never crosses into the night. It
   * stops once checkIsOverdue says the quiet has outlasted the skip window.
   * When every run publishes, a passed time really is a late run, so nothing
   * is stepped.
   */
  function projectedNextCheck() {
    const now = Date.now();
    const next = current?.opsNextCheckAt ?? null;
    if (next !== null && new Date(next).getTime() > now) return next;
    const interval = current?.opsIntervalMinutes ?? null;
    const last = current?.opsProcessedThrough ?? null;
    if (interval === null || interval <= 0 || last === null) return null;
    const step = interval * 60_000;
    const base = next !== null ? new Date(next).getTime() : new Date(last).getTime() + step;
    if (base > now) return new Date(base).toISOString();
    if ((current?.opsMaxStaleMinutes ?? null) === null || checkIsOverdue()) return null;
    return new Date(base + Math.ceil((now - base) / step) * step).toISOString();
  }

  /**
   * Late rather than merely due. The allowance is the publisher's skip window
   * (`opsMaxStaleMinutes`) plus OPS_OVERDUE_FACTOR intervals: a quiet run
   * publishes nothing, so a document up to that old is what a healthy task
   * looks like. Without the skip window the page called a running task
   * stopped every time it went half an hour without news (2026-09-18).
   */
  function checkIsOverdue() {
    const next = current?.opsNextCheckAt ?? null;
    if (next !== null && new Date(next).getTime() > Date.now()) return false;
    const last = current?.opsProcessedThrough ?? null;
    const interval = current?.opsIntervalMinutes ?? null;
    if (last === null || interval === null) return false;
    const allowance = (current?.opsMaxStaleMinutes ?? 0) + interval * OPS_OVERDUE_FACTOR;
    return (Date.now() - new Date(last).getTime()) / 60_000 >= allowance;
  }

  function render(d) {
    current = d;
    renderUpdated();
    renderAuthBanner();
    $("nav-alerts-count").textContent = `(${d.summary.liveAlerts})`;
    $("nav-queue-count").textContent = `(${d.revisitQueue.length})`;
    $("nav-stories-count").textContent = `(${d.stories.length})`;
    // Holdings come from the decrypted vault when unlocked, or from the document
    // when the publisher includes them in the clear (web.holdings). Otherwise
    // they're absent from dashboard.json entirely, not merely hidden here.
    renderTiles(d.summary, holdingRows() !== null);
    renderQueue(d.revisitQueue);
    renderTriggers(d.recentTriggers ?? [], d.summary.windowDays);
    renderStories(d.stories);
    renderQuiet(d.quietWatches, d.quietTotal);
    renderOpsControls();
    renderHoldingsView();
    renderDrawer(parseRoute().drawer);
  }

  // ---- alerts view ----------------------------------------------------------

  function ensureAlerts(force = false) {
    if (alertsPromise && !force) return alertsPromise;
    alertsPromise = fetch("alerts.json", { cache: "no-store" })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then((doc) => {
        alertsDoc = doc;
        populateKindFilter();
        if (baseView === "alerts") renderAlerts();
        const drawer = parseRoute().drawer;
        if (drawer) renderDrawer(drawer);
      })
      .catch((err) => {
        alertsPromise = null;
        $("alerts-status").textContent = `Couldn't load alerts.json (${err.message}).`;
      });
    return alertsPromise;
  }

  function populateKindFilter() {
    const counts = {};
    for (const a of alertsDoc.alerts) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    if (alertsFilter.kind !== "all" && !counts[alertsFilter.kind]) alertsFilter.kind = "all";
    const select = $("alerts-kind");
    select.replaceChildren(
      h("option", { value: "all", text: `All kinds (${alertsDoc.alerts.length})` }),
      ...Object.keys(counts)
        .sort()
        .map((k) => h("option", { value: k, text: `${KIND_LABEL[k] ?? k} (${counts[k]})` }))
    );
    select.value = alertsFilter.kind;
  }

  function nullsLast(x, y, dir) {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  }

  const ALERT_SORTS = {
    symbol: (a, b) => a.symbol.localeCompare(b.symbol),
    closest: (a, b) => nullsLast(a.vsLevelPct === null ? null : Math.abs(a.vsLevelPct), b.vsLevelPct === null ? null : Math.abs(b.vsLevelPct), 1),
    triggered: (a, b) => b.triggerCount - a.triggerCount || nullsLast(a.lastTriggeredAt, b.lastTriggeredAt, -1),
    recent: (a, b) => nullsLast(a.lastTriggeredAt, b.lastTriggeredAt, -1),
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  };

  // ---- the A-Z rail ---------------------------------------------------------
  //
  // A jump list down the left of the alerts table. Only meaningful while the
  // table is sorted by symbol - under "closest to level" or "most triggered"
  // the symbols are in no alphabetical order, and a tab marked M would land
  // somewhere arbitrary - so the rail is hidden under every other sort rather
  // than lying about where it goes.

  /** A symbol's bucket: its first letter, or "#" for the digits and $^ prefixes SYMBOL_RE allows. */
  const initialOf = (symbol) => {
    const c = symbol.trim().charAt(0).toUpperCase();
    return c >= "A" && c <= "Z" ? c : "#";
  };

  const ALPHABET = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  // Height of one tab including its gap, and the chrome above and below the
  // rail. Both are measured from the rendered rail when there is one, so a
  // change to .alpha-rail's padding or font size doesn't need a change here.
  const RAIL_FALLBACK_TAB_PX = 17;
  const RAIL_MIN_TABS = 4;

  /**
   * Splits the alphabet into at most `slots` consecutive groups.
   *
   * Groups are sized by how many letters they span, not by how many alerts
   * they hold: the rail is a map of the alphabet, and a reader looking for
   * "MSFT" wants the tab covering M wherever it falls. Sized evenly, with the
   * remainder spread across the leading groups so no group is more than one
   * letter longer than another.
   */
  function railGroups(slots) {
    if (slots >= ALPHABET.length) return ALPHABET.map((letter) => [letter]);
    const groups = [];
    const size = Math.floor(ALPHABET.length / slots);
    let extra = ALPHABET.length % slots;
    for (let i = 0; i < ALPHABET.length; ) {
      const take = size + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      groups.push(ALPHABET.slice(i, i + take));
      i += take;
    }
    return groups;
  }

  /** How many tabs fit beside the table, from the height actually available. */
  function railCapacity(rail) {
    const tab = rail.firstElementChild;
    const tabPx = tab ? tab.getBoundingClientRect().height + 1 : RAIL_FALLBACK_TAB_PX;
    // The rail is sticky under the header, so what it has to play with is the
    // viewport below its own top edge, less the same margin again at the foot.
    const top = rail.getBoundingClientRect().top;
    const available = window.innerHeight - Math.max(top, 0) - 12;
    return Math.max(RAIL_MIN_TABS, Math.floor(available / Math.max(tabPx, 1)));
  }

  let jumpedRow = null;

  /** Scrolls the first row in `letters` into view and marks where it landed. */
  function jumpToLetters(letters) {
    const table = $("alerts-table");
    const rows = [...table.querySelectorAll("tbody tr[data-initial]")];
    const target = rows.find((tr) => letters.includes(tr.dataset.initial));
    if (!target) return;
    if (jumpedRow) jumpedRow.classList.remove("jumped");
    jumpedRow = target;
    target.classList.add("jumped");
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /**
   * Builds the rail for the rows currently in the table. `present` is the set
   * of initials those rows actually use; a group with none of them is rendered
   * disabled rather than dropped, so the rail keeps the same shape while a
   * search narrows the list.
   *
   * Whether there is a rail at all is decided by the *whole* alert list, not by
   * `present`. Otherwise typing into the search box makes the rail vanish the
   * moment the matches share an initial, shifting the table sideways under the
   * cursor - and the navigation disappears exactly when it is being used.
   */
  function renderAlphaRail(present) {
    const rail = $("alerts-index");
    const initials = new Set((alertsDoc ? alertsDoc.alerts : []).map((a) => initialOf(a.symbol)));
    if (alertsFilter.sort !== "symbol" || initials.size < 2) {
      rail.hidden = true;
      rail.replaceChildren();
      return;
    }
    rail.hidden = false;
    // Two passes: the first gives the rail a tab to measure, the second sizes
    // the groups to the height that tab turns out to need.
    const draw = (slots) => {
      rail.replaceChildren(
        ...railGroups(slots).map((letters) => {
          const label = letters.length === 1 ? letters[0] : `${letters[0]}–${letters[letters.length - 1]}`;
          const enabled = letters.some((l) => present.has(l));
          return h("button", {
            type: "button",
            text: label,
            title: enabled ? `Jump to ${label}` : `No alerts under ${label}`,
            ...(enabled ? { onclick: () => jumpToLetters(letters) } : { disabled: "disabled" }),
          });
        })
      );
    };
    draw(ALPHABET.length);
    const capacity = railCapacity(rail);
    if (capacity < ALPHABET.length) draw(capacity);
  }

  function renderAlerts() {
    renderAddForm();
    renderPending();
    const table = $("alerts-table");
    if (!alertsDoc) {
      table.replaceChildren();
      if (!$("alerts-status").textContent.startsWith("Couldn't")) $("alerts-status").textContent = "Loading…";
      return;
    }
    const needle = alertsFilter.q.trim().toLowerCase();
    const rows = alertsDoc.alerts
      .filter((a) => alertsFilter.kind === "all" || a.kind === alertsFilter.kind)
      .filter((a) => !needle || a.symbol.toLowerCase().includes(needle) || a.condition.toLowerCase().includes(needle))
      .sort(ALERT_SORTS[alertsFilter.sort] ?? ALERT_SORTS.symbol);
    $("alerts-status").textContent = `${rows.length} of ${alertsDoc.alerts.length} · prices ${ago(alertsDoc.generatedAt)}`;

    const head = h("tr", {}, ...["Symbol", "Condition", "Direction", "Level", "Price", "vs level", "Fired", "Last fired"].map((l) => h("th", { text: l })));
    const open = (id) => (location.hash = alertHash(id));
    const body = rows.map((a) =>
      h(
        "tr",
        {
          class: "clickable",
          tabindex: "0",
          // What the A-Z rail scrolls to; set on every row so the rail works
          // against whatever the current filter left in the table.
          "data-initial": initialOf(a.symbol),
          onclick: () => open(a.id),
          onkeydown: (e) => {
            if (e.key === "Enter") open(a.id);
          },
        },
        h("td", {}, symbolLink(a.symbol, a.chartUrl)),
        h("td", { class: "cond" }, a.condition, pendingTag(a.id)),
        h("td", { class: "dir", text: a.direction ? DIRECTION_LABEL[a.direction] ?? a.direction : "–" }),
        h("td", {}, money(a.level ?? a.movingLevel), a.level === null && a.movingLevel !== null ? h("span", { class: "tag", text: "moving" }) : null),
        h("td", { text: money(a.price) }),
        h("td", { text: pct(a.vsLevelPct) }),
        h("td", { text: a.triggerCount }),
        h("td", { text: a.lastTriggeredAt ? when(a.lastTriggeredAt) : "never" })
      )
    );
    if (body.length === 0) {
      table.replaceChildren(h("tbody", {}, h("tr", {}, h("td", { class: "empty", colspan: "8", text: "No alerts match." }))));
      renderAlphaRail(new Set());
      return;
    }
    jumpedRow = null;
    table.replaceChildren(h("thead", {}, head), h("tbody", {}, ...body));
    renderAlphaRail(new Set(rows.map((a) => initialOf(a.symbol))));
  }

  // ---- details drawer -------------------------------------------------------

  const kv = (label, ...value) => [h("dt", { text: label }), h("dd", {}, ...value)];

  /**
   * The position behind a `held` tag, for the row of the details drawer.
   * Read from holdingRows(), never from the trigger or alert row: share
   * counts, basis and value are only in the document when web.holdings is on,
   * and otherwise only in the decrypted vault. On the public site this is
   * simply absent, which is the point.
   */
  function positionValue(symbol) {
    const r = holdingFor(symbol);
    if (!r) return null;
    const parts = [`${r.shares} shares`, `basis ${money(r.basis)}`, ...performanceParts(r)];
    return [
      h("div", { text: parts.join(" · ") }),
      r.stops.length ? h("div", { class: "note", text: `Stop ${r.stops.map(money).join(", ")}` }) : null,
      h(
        "div",
        { class: "note" },
        `Last bought ${r.lastPurchaseDate}${r.ignored ? " · not alerted (ignoreSymbols)" : ""} · `,
        h("a", { href: holdingsHash(symbol), target: HOLDINGS_TARGET, text: "Holdings" })
      ),
    ].filter(Boolean);
  }

  /**
   * The multi-trigger thread for this symbol, when there is one. Stories are
   * built per symbol (narrative.ts, two triggers minimum), so a drawer either
   * has one or the symbol has only fired once.
   */
  function storyBlock(symbol) {
    const story = (current?.stories ?? []).find((s) => s.symbol === symbol);
    if (!story) return null;
    return [
      h("h3", { class: "drawer-sub", text: "Story" }),
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "story" },
          h("div", { class: "headline" }, ...linkLeadingSymbol(story.summary, story.symbol)),
          h("ol", {}, ...story.lines.map((l) => h("li", { text: l.text })))
        )
      ),
    ];
  }

  function volumeText(v) {
    const window = v.window === "today" ? "today" : `in the last ${v.window}`;
    const multiple = v.required > 0 ? ` (${(v.observed / v.required).toFixed(2)}x)` : "";
    return `${sharesText(v.observed)} ${window}, against ${sharesText(v.required)} required${multiple}`;
  }

  function triggerDetail(id) {
    if (!current) return [h("p", { class: "empty", text: "Loading…" })];
    const t = (current.recentTriggers ?? []).find((x) => x.id === id);
    if (!t) {
      return [
        h("h2", { class: "drawer-title", text: "Trigger not found" }),
        h("p", { class: "sub", text: "It's older than the recent-triggers window and no longer open, or its symbol is now ignored." }),
      ];
    }

    const rows = [];
    rows.push(kv("When", full(t.triggeredAt), " ", muted(`(${ago(t.triggeredAt)})`), t.session && SESSION_LABEL[t.session] ? ` · ${SESSION_LABEL[t.session]}` : ""));
    rows.push(kv("Status", ...triggerStatus(t)));

    if (t.condition) {
      rows.push(
        kv(
          "Condition",
          t.condition,
          t.conditionSource === "current" ? h("div", { class: "note", text: "The alert's current settings. This trigger predates recording its condition, so they may have changed since." }) : null
        )
      );
    } else {
      rows.push(kv("Condition", muted(t.alertExists ? "Not recorded." : "Not recorded, and the alert has since been removed.")));
    }

    rows.push(kv("Price at trigger", money(t.triggerPrice)));
    if (t.levelAtTrigger !== null) {
      const vs = t.levelAtTrigger ? muted(` (price ${pct(((t.triggerPrice - t.levelAtTrigger) / t.levelAtTrigger) * 100)})`) : "";
      rows.push(kv(t.ma ? "Average at trigger" : "Level at trigger", money(t.levelAtTrigger), vs));
    }
    if (t.direction) {
      rows.push(kv("Direction", `Crossed ${SIDE_OF[t.direction]} ${t.ma ? "the average" : "the level"}`));
    }

    // Later crossings of the same level, folded onto this fire by the engine.
    const followUps = t.followUps ?? [];
    if (followUps.length > 0) {
      const levelText = t.levelAtTrigger !== null && t.kind !== "trailing" ? ` ${money(t.levelAtTrigger)}` : " the level";
      rows.push(
        kv(
          "Since it fired",
          h(
            "ol",
            { class: "timeline" },
            ...followUps.map((f) => {
              const isReversal = t.reversal !== null && t.reversal !== undefined && f.at === t.reversal.at;
              return h(
                "li",
                { class: isReversal ? "reversal" : null },
                h("span", { class: "when", text: when(f.at) }),
                ` crossed ${SIDE_OF[f.direction] ?? f.direction}${levelText} at ${money(f.price)}`,
                f.session && f.session !== "regular" && SESSION_LABEL[f.session] ? ` · ${SESSION_LABEL[f.session]}` : "",
                isReversal ? h("span", { class: "tag reversed", text: `reversed · ${dayText(t.reversal.tradingDaysAfter)}` }) : null
              );
            })
          )
        )
      );
    }

    const hasVolumeCondition = t.kind === "volume" || /\bvolume\b/.test(t.condition ?? "");
    if (t.volume) {
      rows.push(kv("Volume", volumeText(t.volume)));
    } else if (hasVolumeCondition || t.condition === null) {
      rows.push(kv("Volume", muted("Not recorded for this trigger. Older triggers didn't capture the volume they saw.")));
    }

    if (t.kind !== "volume") {
      rows.push(kv("Breakout check", t.verdict ? VERDICT_LABEL[t.verdict] ?? t.verdict : muted("Not run yet (alert revisit relevel).")));
    }
    if (t.pctMovePastLevel !== null) rows.push(kv("Move past level", pct(t.pctMovePastLevel)));
    if (t.volumeRatio !== null) {
      rows.push(kv("Volume vs normal", `${t.volumeRatio.toFixed(2)}x`, t.volumeTrendRatio !== null ? muted(` · trend ${t.volumeTrendRatio.toFixed(2)}x`) : ""));
    }
    if (t.priority !== null) rows.push(kv("Priority", t.priority.toFixed(0), t.why ? h("div", { class: "note", text: t.why }) : null));
    if (t.suggestedLevel !== null) {
      rows.push(kv("Suggested level", money(t.suggestedLevel), t.suggestionBasis ? h("div", { class: "note", text: t.suggestionBasis }) : null));
    } else if (t.suggestionBasis) {
      rows.push(kv("Suggested level", muted(`None: ${t.suggestionBasis}`)));
    }
    if (t.sinceWatching) {
      rows.push(kv("Since watching", t.sinceWatching));
    } else if (t.watchingSince) {
      rows.push(kv("Watching since", full(t.watchingSince), t.watchingSinceApprox ? muted(" (approximate)") : ""));
    }
    const position = positionValue(t.symbol);
    if (position) rows.push(kv("Position", ...position));
    rows.push(
      kv(
        "Alert",
        t.alertExists ? h("a", { href: alertHash(t.alertId) }, h("code", { text: t.alertId }), ` · ${KIND_LABEL[t.kind] ?? t.kind}`) : muted(`${t.alertId} · removed`)
      )
    );

    return [
      h("h2", { class: "drawer-title" }, symbolLink(t.symbol, t.chartUrl), " ", bareHeadline(t), heldTag(t), reversedTag(t)),
      h("dl", { class: "kv-list" }, ...rows),
      ...(storyBlock(t.symbol) ?? []),
      h(
        "div",
        { class: "actions", style: "margin-top:1.25rem" },
        h("a", { href: t.chartUrl, target: CHART_TARGET, text: "Chart" }),
        t.status === "open" && t.suggestedLevel !== null ? copyButton(`Copy apply → ${t.suggestedLevel}`, `${CLI} alert revisit apply ${t.id}`) : null
      ),
      // A wrapper, because replaceChildren renders a null argument as the text "null".
      h("div", {}, triggerEditSection(t)),
    ];
  }

  /**
   * What became of a trigger, in words: "Changed to 200.6 at 10:25 AM (was
   * 195.3)". A bare "applied" didn't say whether the level moved or where to,
   * and that is the first thing asked of a trigger that no longer offers an
   * edit form.
   */
  function triggerStatus(t) {
    if (t.status === "open") return ["Open"];
    const at = t.resolvedAt ? ` ${atWhen(t.resolvedAt)}` : "";
    if (t.status === "dismissed") return [`Dismissed${at}`];
    if (t.appliedTo !== null && t.appliedTo !== undefined) {
      return [`Changed to ${t.appliedTo}${at}`, t.appliedFrom !== null && t.appliedFrom !== undefined ? muted(` (was ${t.appliedFrom})`) : ""];
    }
    return [`Acted on${at}, level unchanged`];
  }

  /**
   * Re-level the alert this trigger came from, without leaving the panel. The
   * edit carries the entry's id, so applying it also closes the entry: acting
   * on a trigger is what the queue is asking for, and a queue row left open
   * behind an applied edit would only ask again.
   *
   * The alert's current settings live in alerts.json, not in the trigger row,
   * so this waits on that fetch (applyRoute starts it for a trigger drawer).
   */
  function triggerEditSection(t) {
    if (!canEdit() || !t.alertExists) return null;
    // Closed by an earlier edit or a dismiss. An edit from here would try to
    // close it again and be rejected, so send the user to the alert itself.
    if (t.status !== "open") {
      return h("p", { class: "note" }, "This trigger is closed. To change the alert now, ", h("a", { href: alertHash(t.alertId), text: "edit it here" }), ".");
    }
    if (!alertsDoc) return h("p", { class: "note", text: "Loading the alert…" });
    const a = alertsDoc.alerts.find((x) => x.id === t.alertId);
    // Cancelled or on an ignored symbol: alerts.json only carries live ones.
    if (!a) return h("p", { class: "note", text: "The alert behind this trigger is no longer live, so there is nothing to edit." });
    return editSection(a, t.id);
  }

  function alertDetail(id) {
    if (!alertsDoc) return [h("p", { class: "empty", text: "Loading…" })];
    const a = alertsDoc.alerts.find((x) => x.id === id);
    if (!a) {
      return [
        h("h2", { class: "drawer-title", text: "Alert not found" }),
        h("p", { class: "sub", text: "It may have been removed or cancelled, or its symbol is now ignored." }),
      ];
    }

    const rows = [kv("Condition", a.condition), kv("Kind", KIND_LABEL[a.kind] ?? a.kind)];
    if (a.direction) rows.push(kv("Fires on", DIRECTION_DETAIL[a.direction] ?? a.direction));
    if (a.level !== null) {
      rows.push(kv("Level", money(a.level)));
    } else if (a.movingLevel !== null) {
      rows.push(
        kv(
          a.kind === "ma" ? "Average" : "Current trigger",
          money(a.movingLevel),
          h("div", { class: "note", text: a.kind === "ma" ? "As of the last check. It moves with the average." : "Moves as the trail follows price." })
        )
      );
    }
    if (a.price !== null) {
      rows.push(kv("Price", money(a.price), a.vsLevelPct !== null ? muted(` (${pct(a.vsLevelPct)} vs ${a.kind === "ma" ? "average" : "level"})`) : ""));
    }
    rows.push(
      kv(
        "Triggers",
        a.triggerCount === 0 ? "Never fired" : `${a.triggerCount}, last ${full(a.lastTriggeredAt)} at ${money(a.lastTriggerPrice)}`
      )
    );
    rows.push(kv("Watching since", full(a.watchingSince), a.watchingSinceApprox ? muted(" (approximate, from an import)") : ""));
    const position = positionValue(a.symbol);
    if (position) rows.push(kv("Position", ...position));
    rows.push(kv("Alert id", h("code", { text: a.id })));

    const triggers = (current?.recentTriggers ?? []).filter((t) => t.alertId === a.id);
    return [
      h("h2", { class: "drawer-title" }, symbolLink(a.symbol, a.chartUrl), " ", muted(KIND_LABEL[a.kind] ?? a.kind), heldTag(a)),
      h("dl", { class: "kv-list" }, ...rows),
      ...(storyBlock(a.symbol) ?? []),
      h("h3", { class: "drawer-sub", text: "Recent triggers" }),
      triggers.length ? h("div", { class: "card" }, ...triggers.map(triggerRow)) : h("p", { class: "muted", text: "None in the recent window." }),
      h(
        "div",
        { class: "actions", style: "margin-top:1.25rem" },
        h("a", { href: a.chartUrl, target: CHART_TARGET, text: "Chart" }),
        removeAlertButton(a)
      ),
      // A wrapper, because replaceChildren renders a null argument as the text "null".
      h("div", {}, editSection(a)),
    ];
  }

  /**
   * Queues a delete of this alert. `expect.condition` is the same guard an
   * edit carries, so a panel left open while the alert was re-levelled can't
   * delete what it has become. Hidden once a remove is pending.
   */
  function removeAlertButton(a) {
    if (!canEdit() || pendingFor(a.id).some((p) => p.type === "alert.remove")) return null;
    return confirmButton("Remove", () =>
      submitOp(
        { type: "alert.remove", target: { alertId: a.id }, expect: { condition: a.condition }, params: {} },
        { symbol: a.symbol, alertId: a.id, summary: `${a.symbol}: remove alert "${a.condition}"` }
      )
    );
  }

  function renderDrawer(d) {
    const key = d ? `${d.type}:${d.id}` : null;
    const drawer = $("drawer");
    drawer.hidden = key === null;
    $("backdrop").hidden = key === null;
    document.body.classList.toggle("drawer-open", key !== null);
    if (key === null) {
      openDrawerKey = null;
      return;
    }
    $("drawer-body").replaceChildren(...(d.type === "trigger" ? triggerDetail(d.id) : alertDetail(d.id)));
    if (key !== openDrawerKey) {
      openDrawerKey = key;
      drawer.scrollTop = 0;
      drawer.focus();
    }
  }

  // ---- chart panel ------------------------------------------------------------

  // https://s.tradingview.com/embed-widget/advanced-chart/#<json> is what
  // TradingView's own embed-widget-advanced-chart.js currently builds (read
  // out of that script directly: it JSON-stringifies its settings object,
  // including `studies`, into the URL hash - not query params, and not the
  // older `widgetembed/?symbol=...` endpoint, which doesn't take `studies`).
  // It's a cross-origin sandboxed frame with no postMessage API, so this
  // panel can only choose what src to load - it never hears about
  // symbol/timeframe/indicator changes made inside it.
  //
  // `studies_overrides` (the documented way to set a study's length) is
  // unreliable on this endpoint - verified with Playwright against the live
  // page, it repeatedly made the *whole* chart fall back to a blank default
  // (light theme, no indicators), including on at least one run of a config
  // that didn't even use it. Not a key-naming issue to chase, just flakiness
  // in an undocumented endpoint - so no overrides of any kind here.
  //
  // "Moving Average Ribbon" (Pine std id "STD;MA%Ribbon", found by searching
  // the chart's own Indicators picker and reading the id off the WebSocket
  // frame it sends) sidesteps that entirely: it plots four SMAs, and its own
  // out-of-the-box default lengths are exactly 20/50/100/200, so no override
  // is needed to get them - confirmed by screenshotting the live rendered
  // chart, not just the URL.
  //
  // The theme goes out under BOTH `theme` and `colorTheme`. `colorTheme` alone
  // worked when this landed, then stopped (2026-09-17: charts opened light
  // while symbol, interval, the ribbon and the hidden side toolbar all still
  // applied - so the hash was still being read, and only that one key was
  // being dropped). `colorTheme` is the key TradingView's *other* widgets take;
  // `theme` is the advanced chart's own. Both parse, so send both and let
  // whichever the endpoint currently honors win. Don't "tidy" this back to one.
  let chartSymbol = null;
  let chartHref = null;
  function chartEmbedUrl(href) {
    let symbol = "";
    try {
      symbol = new URL(href, location.href).searchParams.get("symbol") ?? "";
    } catch {
      /* malformed href: fall through with no symbol, same as TradingView's own default */
    }
    const colorTheme = root.getAttribute("data-theme") === "light" ? "light" : "dark";
    const settings = {
      symbol,
      interval: "D",
      timezone: "America/New_York",
      theme: colorTheme,
      colorTheme,
      style: "1",
      autosize: true,
      hide_side_toolbar: true,
      allow_symbol_change: true,
      studies: ["STD;MA%Ribbon"],
    };
    return `https://s.tradingview.com/embed-widget/advanced-chart/#${encodeURIComponent(JSON.stringify(settings))}`;
  }

  function openChart(symbol, href) {
    chartSymbol = symbol;
    chartHref = href;
    $("chart-title").textContent = symbol;
    $("chart-frame").src = chartEmbedUrl(href);
    $("chart-backdrop").hidden = false;
    $("chart-panel").hidden = false;
    document.body.classList.add("chart-open");
    $("chart-panel").focus();
  }

  function closeChart() {
    chartSymbol = null;
    chartHref = null;
    $("chart-panel").hidden = true;
    $("chart-backdrop").hidden = true;
    document.body.classList.remove("chart-open");
    $("chart-frame").src = "about:blank"; // stop the widget while it's hidden, not just visually hide it
  }

  // ---- routing --------------------------------------------------------------

  // Views with their own hash; anything unrecognized is the overview.
  const BASE_VIEWS = ["queue", "stories", "alerts", "holdings"];

  function parseRoute() {
    const [view, id] = location.hash.replace(/^#\/?/, "").split("/");
    // #/holdings/<symbol> is the held tag's link: the same view, scrolled to
    // and highlighting one position.
    if (BASE_VIEWS.includes(view)) return { base: view, focus: id ? decodeURIComponent(id) : null, drawer: null };
    if ((view === "trigger" || view === "alert") && id) return { base: null, focus: null, drawer: { type: view, id: decodeURIComponent(id) } };
    return { base: "overview", focus: null, drawer: null };
  }

  function applyRoute() {
    const route = parseRoute();
    // Only a base route changes the focus: a drawer opens over the current
    // view (route.base is null) and must not clear what it is sitting on.
    if (route.base) {
      baseView = route.base;
      const focus = route.base === "holdings" ? route.focus : null;
      if (focus !== focusedHolding) {
        focusedHolding = focus;
        scrollToFocused = focus !== null;
      }
    }
    for (const view of ["overview", ...BASE_VIEWS]) $(`view-${view}`).hidden = baseView !== view;
    for (const link of document.querySelectorAll("[data-nav]")) {
      if (link.dataset.nav === baseView) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    // Both drawers read alerts.json now: the alert drawer to render itself,
    // the trigger drawer for the edit form on the alert behind the fire.
    if (baseView === "alerts" || route.drawer) ensureAlerts();
    if (baseView === "alerts") renderAlerts();
    if (baseView === "holdings") renderHoldingsView();
    renderDrawer(route.drawer);
  }

  const closeDrawer = () => (location.hash = baseView === "overview" ? "#/" : `#/${baseView}`);

  // ---- notifications --------------------------------------------------------

  let swRegistration = null;
  let unseenWhileHidden = 0;
  const baseTitle = document.title;

  function notificationsSupported() {
    return "Notification" in window && window.isSecureContext;
  }

  function renderNotifyControls() {
    const btn = $("notify-btn");
    const state = $("notify-state");
    if (!notificationsSupported()) {
      btn.hidden = true;
      state.textContent = window.isSecureContext ? "notifications unsupported" : "notifications need https";
      return;
    }
    btn.hidden = Notification.permission !== "default";
    state.textContent = Notification.permission === "denied" ? "notifications blocked in browser settings" : "";
  }

  async function systemNotify(t) {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    const title = `${t.symbol} fired`;
    // The service worker opens this hash when the notification is clicked.
    const options = { body: t.headline, tag: t.id, data: { hash: triggerHash(t.id) } };
    try {
      // Android Chrome only allows notifications through a service worker.
      if (swRegistration) {
        await swRegistration.showNotification(title, options);
      } else {
        new Notification(title, options).onclick = () => {
          window.focus();
          location.hash = triggerHash(t.id);
        };
      }
    } catch {
      /* the in-page toast still shows */
    }
  }

  function toast(t) {
    const el = h(
      "div",
      { class: "toast", role: "status" },
      h(
        "div",
        { class: t.id ? "t-body" : null, onclick: t.id ? () => (location.hash = triggerHash(t.id)) : null },
        // The "+N more" toast reuses the symbol slot for a count, which isn't a ticker.
        t.id ? symbolLink(t.symbol, t.chartUrl) : h("span", { class: "t-sym", text: t.symbol }),
        " ",
        t.heldPosition === undefined ? t.headline : bareHeadline(t),
        heldTag(t)
      ),
      h("button", { "aria-label": "Dismiss", text: "×", onclick: () => el.remove() })
    );
    $("toasts").append(el);
    setTimeout(() => el.remove(), 15_000);
  }

  function announce(fresh) {
    if (fresh.length === 0) return;
    const shown = fresh.slice(0, 4);
    shown.forEach(toast);
    if (fresh.length > shown.length) {
      toast({ symbol: `+${fresh.length - shown.length}`, headline: "more fired — see Recent triggers" });
    }
    // System notifications are for when you're looking elsewhere; the toast covers the focused case.
    if (document.hidden || !document.hasFocus()) {
      shown.forEach(systemNotify);
      unseenWhileHidden += fresh.length;
      document.title = `(${unseenWhileHidden}) ${baseTitle}`;
    }
  }

  // ---- polling --------------------------------------------------------------

  let seen = loadSeen();

  async function poll() {
    let d;
    try {
      const resp = await fetch("dashboard.json", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      d = await resp.json();
      $("error").hidden = true;
    } catch (err) {
      $("error").hidden = false;
      $("error").textContent = `Couldn't load dashboard.json (${err.message}). Retrying every minute.`;
      return;
    }

    const triggers = d.recentTriggers ?? [];
    const ids = triggers.map((t) => t.id);
    // First visit on this browser: everything already on the page is history,
    // not news. Announcing a week of triggers at once would be noise.
    if (seen === null) {
      seen = new Set(ids);
      freshIds = new Set();
    } else {
      const fresh = triggers.filter((t) => !seen.has(t.id)).reverse();
      freshIds = new Set([...freshIds, ...fresh.map((t) => t.id)].filter((id) => ids.includes(id)));
      announce(fresh);
      seen = new Set(ids);
    }
    saveSeen(seen);
    render(d);
    resolvePending(d.opResults, d.opsProcessedThrough);
    // Re-read on every poll: the vault is republished alongside the results, and prices move.
    refreshVault();
    if (baseView === "alerts" || parseRoute().drawer) ensureAlerts(true);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      unseenWhileHidden = 0;
      document.title = baseTitle;
      poll();
    }
  });

  $("notify-btn").addEventListener("click", async () => {
    await Notification.requestPermission();
    renderNotifyControls();
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => (swRegistration = reg))
      .catch(() => {});
  }

  // ---- theme (same behavior as uniquetrades-congress: dark default, remembered choice)

  const root = document.documentElement;
  const updateThemeLabel = () => {
    $("theme-btn").textContent = root.getAttribute("data-theme") === "light" ? "🌙 Dark" : "☀️ Light";
  };
  $("theme-btn").addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* choice just won't persist */
    }
    updateThemeLabel();
    // The widget only reads theme at load, so an open chart needs a fresh src.
    if (chartSymbol !== null) $("chart-frame").src = chartEmbedUrl(chartHref);
  });
  updateThemeLabel();

  // ---- wiring ---------------------------------------------------------------

  $("alerts-search").addEventListener("input", (e) => {
    alertsFilter.q = e.target.value;
    renderAlerts();
  });
  $("alerts-kind").addEventListener("change", (e) => {
    alertsFilter.kind = e.target.value;
    renderAlerts();
  });
  $("holdings-account").addEventListener("change", (e) => {
    holdingsAccount = e.target.value;
    renderHoldingsView();
  });
  $("alerts-sort").addEventListener("change", (e) => {
    alertsFilter.sort = e.target.value;
    renderAlerts();
  });
  // A short window fits fewer tabs, so the rail regroups on resize and on the
  // rotation of a phone. Debounced: this runs on every pixel of a drag.
  let railResizeTimer = null;
  window.addEventListener("resize", () => {
    if (baseView !== "alerts" || $("alerts-index").hidden) return;
    clearTimeout(railResizeTimer);
    railResizeTimer = setTimeout(() => {
      const initials = [...$("alerts-table").querySelectorAll("tbody tr[data-initial]")].map((tr) => tr.dataset.initial);
      renderAlphaRail(new Set(initials));
    }, 150);
  });
  $("ops-btn").addEventListener("click", () => {
    if (opsToken) {
      setToken(null);
      return;
    }
    const token = window.prompt("Ops token (the stack's OpsToken parameter):");
    if (token && token.trim()) setToken(token.trim());
  });
  $("drawer-close").addEventListener("click", closeDrawer);
  $("backdrop").addEventListener("click", closeDrawer);
  $("chart-close").addEventListener("click", closeChart);
  $("chart-backdrop").addEventListener("click", closeChart);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (chartSymbol !== null) closeChart();
    else if (openDrawerKey !== null) closeDrawer();
  });
  window.addEventListener("hashchange", applyRoute);

  renderNotifyControls();
  applyRoute();
  poll();
  // Browsers throttle background-tab timers to about once a minute, which is
  // why the interval is a minute: anything faster buys nothing when hidden.
  setInterval(poll, POLL_MS);
  setInterval(() => {
    renderUpdated();
    // Its "expired 2 hr ago" ages with the clock like the rest of this tick.
    renderAuthBanner();
    // "applies in ~9 min" counts down between polls, and goes to the overdue
    // warning on its own when no drain arrives.
    renderPending();
    if (baseView === "alerts" && alertsDoc) $("alerts-status").textContent = $("alerts-status").textContent.replace(/prices .*$/, `prices ${ago(alertsDoc.generatedAt)}`);
  }, 30_000);
})();
