// Browser dashboard. Renders dashboard.json and polls it for new triggers.
//
// Every string from the document is inserted with textContent, never
// innerHTML: symbols ultimately come from imported CSVs.

(() => {
  "use strict";

  const POLL_MS = 60_000;
  const SEEN_KEY = "tva.seenTriggers";
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
      // Only ids still in the document matter; keeps the key from growing forever.
      localStorage.setItem(SEEN_KEY, JSON.stringify([...set]));
    } catch {
      /* per-tab memory still works */
    }
  }

  // ---- formatting -----------------------------------------------------------

  const money = (n) =>
    n === null || n === undefined ? "–" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Headlines lead with the symbol ("Holding MKS broke support"). Where the
  // symbol is already shown as a link, drop it from the sentence; the held
  // state moves to a tag rather than being lost.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bareHeadline = (t) => t.headline.replace(new RegExp(`^(Holding )?${escapeRe(t.symbol)} `), "");
  const heldTag = (t) => (t.heldPosition ? h("span", { class: "tag held", text: "held" }) : null);
  const pct = (n) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);

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
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
          " " +
          d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  const SESSION_LABEL = { pre: "pre-market", post: "after hours" };

  // ---- copy-to-clipboard for CLI commands -----------------------------------

  function copyButton(label, command) {
    const btn = h("button", { title: command, text: label });
    btn.addEventListener("click", async () => {
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

  // ---- rendering ------------------------------------------------------------

  let current = null;
  let freshIds = new Set();
  let holdingsSort = { key: "pctFromBasis", dir: -1 };

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
            h("div", { class: "headline" }, r.headline, r.heldPosition ? h("span", { class: "tag held", text: "held" }) : null),
            h(
              "div",
              { class: "sub" },
              `Fired ${r.levelAtTrigger ?? "–"} @ ${money(r.triggerPrice)} · ${when(r.triggeredAt)}`,
              r.session && SESSION_LABEL[r.session] ? ` · ${SESSION_LABEL[r.session]}` : "",
              r.action ? `. ${r.action}` : ""
            ),
            r.sinceWatching ? h("div", { class: "sub", text: r.sinceWatching }) : null,
            r.why ? h("div", { class: "why", text: r.why }) : null,
            h(
              "div",
              { class: "actions" },
              h("a", { href: r.chartUrl, target: "_blank", rel: "noopener", text: "Chart" }),
              r.suggestedLevel !== null ? copyButton(`Copy apply → ${r.suggestedLevel}`, `${CLI} alert revisit apply ${r.id}`) : null,
              copyButton("Copy dismiss", `${CLI} alert revisit dismiss ${r.id}`)
            )
          )
        )
      )
    );
  }

  function renderTriggers(rows, windowDays) {
    $("triggers-count").textContent = rows.length ? `(${rows.length} in ${windowDays}d)` : "";
    if (rows.length === 0) {
      $("triggers").replaceChildren(h("div", { class: "empty", text: `Nothing has fired in the last ${windowDays} days.` }));
      return;
    }
    $("triggers").replaceChildren(
      ...rows.map((t) =>
        h(
          "div",
          { class: `trigger-row${freshIds.has(t.id) ? " new" : ""}` },
          h("span", { class: "when", text: when(t.triggeredAt) }),
          h("span", {}, h("a", { href: t.chartUrl, target: "_blank", rel: "noopener", text: t.symbol }), " ", bareHeadline(t), heldTag(t)),
          h("span", { class: "status", text: t.status })
        )
      )
    );
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
  }

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
    const options = { body: t.headline, tag: t.id, icon: undefined };
    try {
      // Android Chrome only allows notifications through a service worker.
      if (swRegistration) await swRegistration.showNotification(title, options);
      else new Notification(title, options).onclick = () => window.focus();
    } catch {
      /* the in-page toast still shows */
    }
  }

  function toast(t) {
    const el = h(
      "div",
      { class: "toast", role: "status" },
      h("div", {}, h("span", { class: "t-sym", text: t.symbol }), " ", t.heldPosition === undefined ? t.headline : bareHeadline(t), heldTag(t)),
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

  const THEME_KEY = "tva-theme";
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

  renderNotifyControls();
  poll();
  // Browsers throttle background-tab timers to about once a minute, which is
  // why the interval is a minute: anything faster buys nothing when hidden.
  setInterval(poll, POLL_MS);
  setInterval(renderUpdated, 30_000);
})();
