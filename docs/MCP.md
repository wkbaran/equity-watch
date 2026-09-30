# MCP server (`equity-watch mcp`)

The dashboard's agent tools, for agents that don't run in a browser: Claude Code
over stdio, and Open WebUI (or anything else that speaks Streamable HTTP).

They are the same tools the page offers through WebMCP ([DASHBOARD.md](DASHBOARD.md#agent-tools-webmcp)).
The server imports `web/webmcp.js` and serves its tool list. Names, schemas,
argument checks, the duplicate-change guard and the ops each tool queues are
therefore identical; only the host differs.

## What it talks to

The server is a page with no window. It reads the published `dashboard.json`,
`alerts.json` and `vault.json`, and queues changes by POSTing to the site's
`/api/ops` with the ops token, the same request the page sends. It needs:

- the **site address**: `--site-url`, else `DASHBOARD_URL`, else `https://$CUSTOM_DOMAIN` from `.env`;
- the **ops token**: `OPS_TOKEN` in `.env`. Without it the server is read-only;
- the **site's login**, if it has basic auth (`ENABLE_BASIC_AUTH=true`):
  `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`, the same pair the stack deploy
  reads. They go on reads only; `/api/ops` is outside the login and takes the
  ops token instead.

It needs nothing from the machine that runs the checks, so it runs wherever the
agent does. Its data is as fresh as the last publish, and changes apply at the
next scheduled check, exactly as from the page. It refetches `dashboard.json`
when a call finds it more than a minute old.

It reads the repo's `.env` even when started from another directory, which is
how MCP clients usually start it.

## Who gets which tools

| Tools | Offered when |
|---|---|
| `get_overview`, `list_revisit_queue`, `list_alerts`, `get_alert`, `get_pending_changes` | always |
| alert and revisit-queue writes | there's an `OPS_TOKEN`, the site accepts ops, and no `--read-only` |
| holdings: positions, lots, stops, stories | also `--allow-holdings`, and the token opens the vault |

`--allow-holdings` is the headless counterpart of the page's "Agents may see
holdings" box, and it is off for the same reason: tool output goes to the
agent's model, and the vault exists so that no server sees your positions.

## Approving changes

Every write asks the person first. The page shows a dialog; the server asks
through **MCP elicitation**, a yes/no form the client displays, when the client
supports it. Declining, dismissing, or not answering within two minutes queues
nothing.

A client without elicitation can't show that question. By default the server
then relies on the client's own approval of the tool call, and the result tells
the agent so. Claude Code asks before each tool call unless you've allowed the
tool. Not every client asks: check yours before relying on this. A client that
runs tool calls without a confirmation step (a common default in chat UIs,
possibly Open WebUI's) would queue changes on the model's say-so alone, so with
such a client either:

- start the server with `--require-approval`, which offers write tools only to
  clients that support elicitation; or
- use `--read-only`.

Write tools carry MCP annotations (`destructiveHint` on removals and dismissals),
which clients use to decide what to confirm.

## Running it

```sh
# stdio, for Claude Code (from the repo; or `node dist/cli.js mcp` after npm run build)
claude mcp add equity-watch -- npx tsx /path/to/equity-watch/src/cli.ts mcp

# Streamable HTTP on http://127.0.0.1:4190/mcp, for Open WebUI
npx tsx src/cli.ts mcp --http --require-approval
```

In Open WebUI, add a tool server of type **MCP (Streamable HTTP)** with the URL
`http://localhost:4190/mcp`:

- **Open WebUI on Windows with WSL mirrored networking** reaches a WSL server on
  `localhost` directly.
- **Open WebUI in Docker** needs `--host 0.0.0.0` and the URL
  `http://host.docker.internal:4190/mcp`. Binding beyond loopback requires
  `MCP_HTTP_TOKEN` in `.env`, which the client then sends as a bearer token.

On a Docker host, the compose file's `mcp` service runs it long-lived on its own
LAN address; see [docker/README.md](../docker/README.md#the-mcp-server-optional).

Flags: `--http [port]` (default 4190), `--host`, `--site-url`, `--read-only`,
`--allow-holdings`, `--require-approval`, `--pending-file`.

## Things that look odd and aren't

- **Pending changes live in a file** (`.cache/mcp-pending.json` by default), not
  in memory. A stdio client starts a new server for each session, and the guard
  against queueing the same change twice has to outlive that. Entries clear
  themselves once the published results, or the drain watermark, say they were
  applied (`settlePending`, shared with the page).
- **HTTP sessions are stateful.** Elicitation is a request from the server to the
  client, and a stateless transport has no channel to send it on.
- **The HTTP endpoint refuses browsers.** A server on localhost can be reached by
  any page open in your browser. Requests must carry a `Host` naming the server
  (which defeats DNS rebinding), and any `Origin` must be local. Open WebUI
  connects from its backend and sends none.
- **Nothing but protocol goes to stdout.** On stdio, stdout *is* the protocol,
  and a stray `console.log` breaks the session. The server logs to stderr, and a
  test checks the spawned process.

## Testing

- `tests/mcp.test.ts` runs the server against `playwright/server.ts` (fixture
  documents, a sealed fixture vault, a fake `/api/ops`), with an SDK client
  in-process, over stdio, and over HTTP.
- `npx tsx playwright/agentEval.ts --via mcp` gives the same ten tasks the page
  is evaluated on to a local model, with the person answering elicitation.
