# Running equity-watch on a Docker host

One container runs `scripts/check-and-publish.sh` every 15 minutes: apply queued
dashboard edits, check alerts, publish the dashboard. It is the same loop the
Windows task runs (`docs/SCHEDULING.md`), minus the daily window: outside a
session `alert check` fetches no quotes, so an overnight run costs nothing.

Run everything below from the repo root. `docker compose` here means
`docker compose -f docker/docker-compose.yaml`; alias it if you like.

## First start

```sh
cp .env.example .env        # fill in SCHWAB_*, S3_BUCKET, AWS_*, OPS_* (see docs/SETUP.md)
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

The tokens land in the volume, and the running container picks them up on its
next run. **Repeat this weekly**: Schwab refresh tokens last 7 days. When one
lapses the container keeps running, publishes "login expired" to the dashboard,
and (if `HEALTHCHECK_URL` is set) pings `<url>/fail`.

## Bringing your existing state over

State lives in the `equity-watch_data` volume, mounted at `/data`. **Stop the
old scheduler first** (disable the Windows task, or the cron entry). Two
machines checking against two copies of `alerts.json` diverge and re-fire each
other's alerts.

With the container created (`up` or `create`), copy from the old checkout:

```sh
for f in alerts.json revisits.json holdings.json ops.log.jsonl; do
  docker compose -f docker/docker-compose.yaml cp "$f" equity-watch:/data/
done
docker compose -f docker/docker-compose.yaml cp .cache equity-watch:/data/
docker compose -f docker/docker-compose.yaml cp ~/.equity_watch/schwab_tokens.json equity-watch:/data/.equity_watch/
docker compose -f docker/docker-compose.yaml restart equity-watch
```

Copied files arrive root-owned; the entrypoint chowns them on the restart. The
token copy needs `/data/.equity_watch` to exist first, so if it fails, run
`schwab-login` once (which creates it) or skip the copy and log in.

## Everyday use

| | |
|---|---|
| Any CLI command | `docker compose -f docker/docker-compose.yaml run --rm cli alert list` |
| Logs | `docker compose -f docker/docker-compose.yaml logs -f` |
| Run a check now | `docker compose -f docker/docker-compose.yaml exec -u node equity-watch /app/scripts/check-and-publish.sh` |
| Update after `git pull` | `docker compose -f docker/docker-compose.yaml up -d --build` |
| Back up state | `docker run --rm -v equity-watch_data:/data -v "$PWD":/backup alpine tar czf /backup/equity-watch-data.tgz -C /data .` |

Use `run --rm cli`, or `exec -u node`, rather than a bare `exec`: `exec` starts as
root and would leave root-owned files in `/data` (the next container start
repairs them, but a live run in between could not write them).

## Knobs

- `CHECK_INTERVAL_MINUTES` (default 15) and `TZ` (default `America/Denver`) can be
  set in `.env` or the shell. `TZ` only affects log timestamps and report file
  names; market logic is pinned to `America/New_York` in the code.
- The container's Docker health is "the loop is still completing runs". An expired
  Schwab login does **not** make it unhealthy; that is what the dashboard banner
  and `HEALTHCHECK_URL` are for.
- `analysis.config.json` is seeded into `/data` on first start from the copy in the
  image. After that the volume's copy wins, so edit it there.
