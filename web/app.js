// Browser dashboard.
//
// Views are hash routes, so the poller and notifications keep running
// whichever one is open:
//   #/              overview        (dashboard.json, polled every minute)
//   #/alerts        every live alert (alerts.json, fetched while viewed)
//   #/trigger/<id>  one trigger's details, in a drawer over the current view
//   #/alert/<id>    one alert's details and its recent triggers
//
// Every string from the documents is inserted with textContent, never
// innerHTML: symbols ultimately come from imported CSVs. Every sentence shown
// is either read off the documents or a fixed label here; nothing is inferred.

(() => {
  "use strict";

  const POLL_MS = 60_000;
  const SEEN_KEY = "tva.seenTriggers";
  const THEME_KEY = "tva-theme";
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
      const raw = localStorage.getItem(SEEN_KEY);
      return raw === null ? null : new Set(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function saveSeen(set) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...set]));
    } catch {
      /* per-tab memory still works */
    }
  }

  // ---- formatting -----------------------------------------------------------

  const money = (n) =>
    n === null || n === undefined ? "–" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);
  const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
  const shares = (n) => `${COMPACT.format(n)} shares`;

  function ago(iso) {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr} hr ago`;
    return `${Math.round(hr / 24)} days ago`;
  }

  function when(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
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
  // Headlines lead with the symbol ("Holding MKS broke support"). Where the
  // symbol is shown separately, drop it from the sentence; held becomes a tag.
  const bareHeadline = (t) => t.headline.replace(new RegExp(`^(Holding )?${escapeRe(t.symbol)} `), "");
  const heldTag = (t) => (t.heldPosition ? h("span", { class: "tag held", text: "held" }) : null);
  const muted = (text) => h("span", { class: "muted", text });

  const SESSION_LABEL = { pre: "pre-market", regular: "regular hours", post: "after hours" };
  const KIND_LABEL = { static: "Static", trailing: "Trailing", volume: "Volume", ma: "Moving average" };
  // Plain names for analysis.ts verdicts. Kept literal: NO_CLOSE_CONFIRM in
  // particular must never read as a breakout.
  const VERDICT_LABEL = {
    CONFIRMED_BREAKOUT: "Confirmed breakout",
    WATCH: "Broke out on volume but didn't hold",
    WATCH_WEAK: "Weak: thin volume or not at a real high",
    NO: "Not confirmed",
    NO_CLOSE_CONFIRM: "Didn't close past the level",
    INSUFFICIENT_DATA: "Not enough data to judge",
    SKIPPED: "Skipped",
    PROVIDER_ERROR: "Price data unavailable",
  };

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

  // ---- state ----------------------------------------------------------------

  let current = null; // dashboard.json
  let alertsDoc = null; // alerts.json
  let alertsPromise = null;
  let freshIds = new Set();
  let holdingsSort = { key: "pctFromBasis", dir: -1 };
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
            h("div", { class: "headline" }, h("a", { class: "plain", href: triggerHash(r.id), text: r.headline }), r.heldPosition ? h("span", { class: "tag held", text: "held" }) : null),
            h(
              "div",
              { class: "sub" },
              `Fired ${r.levelAtTrigger ?? "–"} @ ${money(r.triggerPrice)} · ${when(r.triggeredAt)}`,
              r.session && r.session !== "regular" && SESSION_LABEL[r.session] ? ` · ${SESSION_LABEL[r.session]}` : "",
              r.action ? `. ${r.action}` : ""
            ),
            r.sinceWatching ? h("div", { class: "sub", text: r.sinceWatching }) : null,
            r.why ? h("div", { class: "why", text: r.why }) : null,
            h(
              "div",
              { class: "actions" },
              h("a", { href: triggerHash(r.id), text: "Details" }),
              h("a", { href: r.chartUrl, target: "_blank", rel: "noopener", text: "Chart" }),
              r.suggestedLevel !== null ? copyButton(`Copy apply → ${r.suggestedLevel}`, `${CLI} alert revisit apply ${r.id}`) : null,
              copyButton("Copy dismiss", `${CLI} alert revisit dismiss ${r.id}`)
            )
          )
        )
      )
    );
  }

  function triggerRow(t) {
    return h(
      "a",
      { class: `trigger-row${freshIds.has(t.id) ? " new" : ""}`, href: triggerHash(t.id) },
      h("span", { class: "when", text: when(t.triggeredAt) }),
      h("span", {}, h("strong", { text: t.symbol }), " ", bareHeadline(t), heldTag(t)),
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
    $("stories-section").hidden = stories.length === 0;
    $("stories").replaceChildren(
      ...stories.map((s) =>
        h("div", { class: "story" }, h("div", { class: "headline", text: s.summary }), h("ol", {}, ...s.lines.map((l) => h("li", { text: l.text }))))
      )
    );
  }

  const HOLDING_COLS = [
    { key: "symbol", label: "Symbol" },
    { key: "shares", label: "Shares" },
    { key: "basis", label: "Basis" },
    { key: "price", label: "Price" },
    { key: "pctFromBasis", label: "vs basis" },
    { key: "bar", label: "", sortable: false },
    { key: "marketValue", label: "Value" },
  ];

  function renderHoldings(rows) {
    $("holdings-count").textContent = rows.length ? `(${rows.length})` : "";
    const { key, dir } = holdingsSort;
    const sorted = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === null) return 1;
      if (bv === null) return -1;
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * dir;
    });
    // Scale bars to the largest move shown, capped so one outlier can't flatten the rest.
    const span = Math.min(50, Math.max(5, ...rows.map((r) => Math.abs(r.pctFromBasis ?? 0))));

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

    const body = sorted.map((r) => {
      const p = r.pctFromBasis;
      const width = p === null ? 0 : (Math.min(Math.abs(p), span) / span) * 50;
      return h(
        "tr",
        { class: r.ignored ? "ignored" : null, title: r.ignored ? "Not alerted (ignoreSymbols)" : null },
        h("td", {}, r.symbol, r.stops.length ? h("span", { class: "tag", text: `stop ${r.stops.join(", ")}` }) : null),
        h("td", { text: r.shares }),
        h("td", { text: money(r.basis) }),
        h("td", { text: money(r.price) }),
        h("td", { text: pct(p) }),
        h("td", { class: "bar-cell" }, h("div", { class: "bar" }, p ? h("span", { class: p > 0 ? "up" : "down", style: `width:${width}%` }) : null)),
        h("td", { text: money(r.marketValue) })
      );
    });
    $("holdings").replaceChildren(h("thead", {}, head), h("tbody", {}, ...body));
  }

  function renderQuiet(notes, total) {
    $("quiet-section").hidden = notes.length === 0;
    $("quiet-summary").textContent = `${total} watched a while with nothing since${total > notes.length ? ` (showing ${notes.length})` : ""}`;
    $("quiet").replaceChildren(...notes.map((n) => h("li", { text: n })));
  }

  function renderUpdated() {
    if (!current) return;
    const el = $("updated");
    el.textContent = `Updated ${ago(current.generatedAt)}`;
    el.title = new Date(current.generatedAt).toLocaleString();
  }

  function render(d) {
    current = d;
    renderUpdated();
    $("nav-alerts-count").textContent = `(${d.summary.liveAlerts})`;
    // The publisher decides this, not the page: with holdings off they are
    // absent from dashboard.json entirely, not merely hidden here.
    const showHoldings = d.site?.holdings === true;
    renderTiles(d.summary, showHoldings);
    renderQueue(d.revisitQueue);
    renderTriggers(d.recentTriggers ?? [], d.summary.windowDays);
    renderStories(d.stories);
    $("holdings-section").hidden = !showHoldings;
    if (showHoldings) renderHoldings(d.holdings);
    renderQuiet(d.quietWatches, d.quietTotal);
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

  function renderAlerts() {
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

    const head = h("tr", {}, ...["Symbol", "Condition", "Level", "Price", "vs level", "Fired", "Last fired"].map((l) => h("th", { text: l })));
    const open = (id) => (location.hash = alertHash(id));
    const body = rows.map((a) =>
      h(
        "tr",
        {
          class: "clickable",
          tabindex: "0",
          onclick: () => open(a.id),
          onkeydown: (e) => {
            if (e.key === "Enter") open(a.id);
          },
        },
        h("td", {}, h("strong", { text: a.symbol })),
        h("td", { class: "cond", text: a.condition }),
        h("td", {}, money(a.level ?? a.movingLevel), a.level === null && a.movingLevel !== null ? h("span", { class: "tag", text: "moving" }) : null),
        h("td", { text: money(a.price) }),
        h("td", { text: pct(a.vsLevelPct) }),
        h("td", { text: a.triggerCount }),
        h("td", { text: a.lastTriggeredAt ? when(a.lastTriggeredAt) : "never" })
      )
    );
    if (body.length === 0) {
      table.replaceChildren(h("tbody", {}, h("tr", {}, h("td", { class: "empty", colspan: "7", text: "No alerts match." }))));
      return;
    }
    table.replaceChildren(h("thead", {}, head), h("tbody", {}, ...body));
  }

  // ---- details drawer -------------------------------------------------------

  const kv = (label, ...value) => [h("dt", { text: label }), h("dd", {}, ...value)];

  function volumeText(v) {
    const window = v.window === "today" ? "today" : `in the last ${v.window}`;
    const multiple = v.required > 0 ? ` (${(v.observed / v.required).toFixed(2)}x)` : "";
    return `${shares(v.observed)} ${window}, against ${shares(v.required)} required${multiple}`;
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
    rows.push(kv("Status", t.status, t.resolvedAt ? muted(` · ${full(t.resolvedAt)}`) : ""));

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
    rows.push(
      kv(
        "Alert",
        t.alertExists ? h("a", { href: alertHash(t.alertId) }, h("code", { text: t.alertId }), ` · ${KIND_LABEL[t.kind] ?? t.kind}`) : muted(`${t.alertId} · removed`)
      )
    );

    return [
      h("h2", { class: "drawer-title" }, h("strong", { text: t.symbol }), " ", bareHeadline(t), heldTag(t)),
      h("dl", { class: "kv-list" }, ...rows),
      h(
        "div",
        { class: "actions", style: "margin-top:1.25rem" },
        h("a", { href: t.chartUrl, target: "_blank", rel: "noopener", text: "Chart" }),
        t.status === "open" && t.suggestedLevel !== null ? copyButton(`Copy apply → ${t.suggestedLevel}`, `${CLI} alert revisit apply ${t.id}`) : null,
        t.status === "open" ? copyButton("Copy dismiss", `${CLI} alert revisit dismiss ${t.id}`) : null
      ),
    ];
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
    rows.push(kv("Alert id", h("code", { text: a.id })));

    const triggers = (current?.recentTriggers ?? []).filter((t) => t.alertId === a.id);
    return [
      h("h2", { class: "drawer-title" }, h("strong", { text: a.symbol }), " ", muted(KIND_LABEL[a.kind] ?? a.kind)),
      h("dl", { class: "kv-list" }, ...rows),
      h("h3", { class: "drawer-sub", text: "Recent triggers" }),
      triggers.length ? h("div", { class: "card" }, ...triggers.map(triggerRow)) : h("p", { class: "muted", text: "None in the recent window." }),
      h(
        "div",
        { class: "actions", style: "margin-top:1.25rem" },
        h("a", { href: a.chartUrl, target: "_blank", rel: "noopener", text: "Chart" }),
        copyButton("Copy remove", `${CLI} alert remove ${a.id}`)
      ),
    ];
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

  // ---- routing --------------------------------------------------------------

  function parseRoute() {
    const [view, id] = location.hash.replace(/^#\/?/, "").split("/");
    if (view === "alerts") return { base: "alerts", drawer: null };
    if ((view === "trigger" || view === "alert") && id) return { base: null, drawer: { type: view, id: decodeURIComponent(id) } };
    return { base: "overview", drawer: null };
  }

  function applyRoute() {
    const route = parseRoute();
    if (route.base) baseView = route.base;
    $("view-overview").hidden = baseView !== "overview";
    $("view-alerts").hidden = baseView !== "alerts";
    for (const link of document.querySelectorAll("[data-nav]")) {
      if (link.dataset.nav === baseView) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (baseView === "alerts" || route.drawer?.type === "alert") ensureAlerts();
    if (baseView === "alerts") renderAlerts();
    renderDrawer(route.drawer);
  }

  const closeDrawer = () => (location.hash = baseView === "alerts" ? "#/alerts" : "#/");

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
        h("span", { class: "t-sym", text: t.symbol }),
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
    if (baseView === "alerts" || parseRoute().drawer?.type === "alert") ensureAlerts(true);
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
  $("alerts-sort").addEventListener("change", (e) => {
    alertsFilter.sort = e.target.value;
    renderAlerts();
  });
  $("drawer-close").addEventListener("click", closeDrawer);
  $("backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openDrawerKey !== null) closeDrawer();
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
    if (baseView === "alerts" && alertsDoc) $("alerts-status").textContent = $("alerts-status").textContent.replace(/prices .*$/, `prices ${ago(alertsDoc.generatedAt)}`);
  }, 30_000);
})();
