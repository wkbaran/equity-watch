# Running equity-watch on a Docker host

One container runs `scripts/check-and-publish.sh` every 15 minutes: apply queued
dashboard edits, check alerts, publish the dashboard. It is the same job the
Windows task runs (`docs/SCHEDULING.md`), minus the daily window: outside a
session `alert check` fetches no quotes, so an overnight run costs nothing. A second,
weekday job refreshes the betas file another container reads ([below](#sharing-betas-with-another-container)).

The scheduler is [supercronic](https://github.com/aptible/supercronic) reading
`docker/crontab`. Each tick runs `docker/run-check.sh`, which wraps the check with
the healthcheck heartbeat and the `HEALTHCHECK_URL` ping. The first run comes at
the next quarter hour after start, not at start.

Run everything below from the repo root. `docker compose` here means
`docker compose -f docker/docker-compose.yaml`; alias it if you like.

## Where things live

There are no named volumes. Everything the container writes is a bind mount of
one directory on the Docker host, `STATE_DIR`, at `/data`:

```
~/equity-watch/          (STATE_DIR on the host)
  alerts.json revisits.json holdings.json ops.log.jsonl analysis.config.json
  .cache/  site/
  .equity_watch/schwab_tokens.json
```

Set it in `docker/.env` (gitignored; compose reads it on the machine running
`docker compose`):

```sh
STATE_DIR=/var/home/core/equity-watch    # absolute path on the Docker host
```

It has no default on purpose. An unset one would mount an empty directory, and
the first run would publish an empty dashboard over the real one.

## Deploying to a remote host

Same as outlier-caucus: compose runs here and talks to the host's Docker over
ssh, so the repo, `.env` and `docker/.env` stay on this machine.

```sh
export DOCKER_HOST=ssh://core@HOST
ssh core@HOST 'mkdir -p ~/equity-watch/.equity_watch'
```

## First start

```sh
cp .env.example .env        # fill in SCHWAB_*, S3_BUCKET, AWS_*, OPS_* (see docs/SETUP.md)
# put the state in STATE_DIR first (next section), or log in and start fresh
docker compose -f docker/docker-compose.yaml up -d --build
docker compose -f docker/docker-compose.yaml logs -f
```

`.env` is read at run time. It is not copied into the image (`.dockerignore`
keeps it, and the state files, out of the build context).

Then log in to Schwab. There is no browser in the container, so the command
prints the authorize URL; open it on any machine, approve, and paste back the
URL you were redirected to:

```sh
docker compose -f docker/docker-compose.yaml run --rm cli schwab-login
```

The tokens land in `STATE_DIR/.equity_watch`, and the running container picks
them up on its next run. **Repeat this weekly**: Schwab refresh tokens last 7
days. When one lapses the container keeps running, publishes "login expired" to
the dashboard, and (if `HEALTHCHECK_URL` is set) pings `<url>/fail`.

For the Webull sync, log in from the container the same way, so its token is the
only one (docs/HOLDINGS.md#syncing-from-webull). It prints what to do, then waits
for the SMS code to be entered in the Webull app:

```sh
docker compose -f docker/docker-compose.yaml run --rm cli webull-login
```

## Sharing betas with another container

A second job, `docker/run-beta.sh`, writes Schwab's beta for a list of symbols to a
directory another container reads, so that program needs no Schwab login of its
own. It is `equity-watch beta` (format and guarantees: [`docs/BETA.md`](../docs/BETA.md)):

```
/shared/underlyings.txt    input: one symbol per line, # comments allowed (the other program writes it)
/shared/betas.json         output: equity-watch/betas@1, replaced atomically
```

**One-time host setup.** Choose an absolute path, set it as `SHARED_DIR` in
`docker/.env` (required, with no default, like `STATE_DIR`; template in
`docker/.env.example`), and create it owned by uid 1000, which is the `node` user
the container runs as:

```sh
mkdir -p "$SHARED_DIR" && chown 1000:1000 "$SHARED_DIR" && chmod 0755 "$SHARED_DIR"
```

The other container mounts the same directory. Three details that break it
quietly:

- **Mount the directory, not `betas.json`.** The write is a temp file made beside
  the target and renamed over it; a single-file mount has no place to make one.
- **`:z`, never `:Z`.** `:z` (already in the compose file) labels the directory
  as shared between containers on an SELinux host. `:Z` labels it for one
  container and the other is denied.
- **uid 1000 must be able to write the directory.** The reader may run as root and
  write anywhere; this container cannot, and the first run would fail with
  "Could not write /shared/betas.json".

Only the `equity-watch` and `cli` services mount it; `mcp` does not.

**When it runs:** weekdays at 08:05 and 14:05 in the container's `TZ` (Denver by
default), from `docker/crontab`. The other program publishes at 07:45 and 13:25,
so each run follows a publish by about 20 and 40 minutes, and a symbol added to
`underlyings.txt` has a beta within a day. It has none in the first report that
lists it.

**When it fails, the old file stays.** A 429, a 5xx or a lapsed login writes
nothing; the next scheduled run tries again, with no retry logic of its own, and
the reader decides from `generatedAt` when the file is too old to use. A lapsed
login logs `beta: login expired, keeping the old betas` and exits 3. The job does
not touch the container's heartbeat or `HEALTHCHECK_URL`: the 15-minute check
already reports a lapsed login there. It runs at 30 Schwab requests a minute
(`SCHWAB_MAX_REQUESTS_PER_MINUTE`, for this process only) because the check is a
separate process with its own limiter, and the two together must stay under 120.

To run it now, or right after the weekly login:

```sh
docker compose exec -u node equity-watch /app/docker/run-beta.sh
# or, with nothing scheduled involved:
docker compose run --rm cli beta --symbols-file /shared/underlyings.txt --out /shared/betas.json
```

## Bringing your existing state over

**Stop the old scheduler first** (disable the Windows task, or the cron entry).
Two machines checking against two copies of `alerts.json` diverge and re-fire
each other's alerts. Copy the state in **before** the first `up`.

From the old checkout (`HOST` and `STATE_DIR` as above):

```sh
scp alerts.json revisits.json holdings.json ops.log.jsonl core@HOST:equity-watch/
scp -r .cache core@HOST:equity-watch/
scp ~/.equity_watch/schwab_tokens.json core@HOST:equity-watch/.equity_watch/
```

The token file is optional (it saves a login if it hasn't expired). `site/` is
not copied: the first publish rebuilds it. The entrypoint chowns anything not
owned by `node` (uid 1000, the same as `core` on nuc1) on start.

## Everyday use

| | |
|---|---|
| Any CLI command | `docker compose -f docker/docker-compose.yaml run --rm cli alert list` |
| Logs | `docker compose -f docker/docker-compose.yaml logs -f` |
| Run a check now | `docker compose -f docker/docker-compose.yaml exec -u node equity-watch /app/scripts/check-and-publish.sh` |
| Update after `git pull` | `docker compose -f docker/docker-compose.yaml up -d --build` |
| Back up state | `ssh core@HOST 'tar czf - -C ~/equity-watch .' > equity-watch-data.tgz` |

Use `run --rm cli`, or `exec -u node`, rather than a bare `exec`: `exec` starts as
root and would leave root-owned files in `/data` (the next container start
repairs them, but a live run in between could not write them).

## The MCP server (optional)

A second service, `mcp`, serves the dashboard's agent tools over Streamable
HTTP ([docs/MCP.md](../docs/MCP.md)) for Open WebUI or any other MCP client on
the home network. It is off unless `docker/.env` turns on its profile:

```sh
COMPOSE_PROFILES=mcp
# required with the profile on: a free address on the macvlan, and its DNS name
MCP_IPV4=192.0.2.53
MCP_HOSTNAME=equity-watch.example
```

Then `up -d --build` as usual starts it beside the scheduler. It needs, in `.env`:

- `MCP_HTTP_TOKEN`: the bearer every client must send (`openssl rand -hex 32`).
  The server refuses to listen beyond loopback without one.
- `OPS_TOKEN`, for write tools, and `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` if
  the site has basic auth. It reads the published site like the page does, so it
  needs nothing else from `STATE_DIR` except somewhere to keep its pending list.
- `MCP_FLAGS`, optionally: extra server flags such as `--require-approval` or
  `--allow-holdings`, space-separated.

It joins the external macvlan network `app-network` at `MCP_IPV4`, and CoreDNS's
docker discovery names it from the `coredns.dockerdiscovery.host` label. In Open
WebUI, add a tool server of type **MCP (Streamable HTTP)** at
`http://<MCP_HOSTNAME>:4180/mcp` with the token as its bearer. Two macvlan
facts to know:

- **The Docker host can't reach the container's address**, as with any macvlan
  container. Containers on `app-network` (Open WebUI) and other machines can.
- **It is plain HTTP.** The bearer crosses the LAN unencrypted, so anyone who
  can see that traffic can queue changes with it.

## Knobs

- The schedule is `docker/crontab`; change it and rebuild. `healthcheck.sh` assumes
  15 minutes (unhealthy after 50 without a run), so change that with it.
- `TZ` (default `America/Denver`) can be set in `.env` or the shell. It sets what
  the crontab's times mean and the log timestamps and report file names; market
  logic is pinned to `America/New_York` in the code.
- The container's Docker health is "scheduled runs are still completing". An expired
  Schwab login does **not** make it unhealthy; that is what the dashboard banner
  and `HEALTHCHECK_URL` are for.
- `analysis.config.json` is seeded into `STATE_DIR` on first start from the copy in
  the image. After that the host's copy wins, so edit it there.
- The container passes no `--next-check` (the Windows script reads it from Task
  Scheduler), so the page's "next check" comes from the cadence `ops pull` measures.
