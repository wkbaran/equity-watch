# User Change Events Plan

Letting the browser dashboard change the watchlist: apply or dismiss a revisit,
snooze, remove, add alerts. Today it can only copy CLI commands.

Status: **add and edit built** (2026-09-15). The rest is proposed.

What shipped, and where it differs from the plan below:

- **Ops:** `alert.add` and `alert.edit` only. Revisit apply/dismiss, snooze,
  remove, and quiet cleanup are not built. On the page, add creates static
  alerts. Edit covers static level/direction and trailing distance. The worker
  accepts every field `alert add`/`alert edit` do.
- **Auth:** the ops token, as proposed. Reads stay public, and no federated login.
- **Latency:** no separate worker. `ops pull` runs as the first step of the
  existing 15-minute scheduled task, so a change can wait up to 15 minutes.
  Nothing applies outside the task's weekday window.
- **Idempotency is the op log** (`ops.log.jsonl`), not SQS dedup, which lasts
  only five minutes. An op id already logged returns its result without
  applying again.
- **Conflict guard:** `expect.condition` is the alert's condition text as the page
  showed it, not per-field values.
- **Results** are published as `opResults` on the site document (`siteDocument`),
  not on the shared `Dashboard`, so the terminal and Kindle renderers are untouched.
- **Validation** was pulled out of `cli.ts` into `src/ops/validate.ts` rather than
  moving whole commands to `src/ops/apply.ts`, since `addAlert`/`editAlert` were
  already store-level functions.

---

## Why this is not trivial

The dashboard is a static site on S3/CloudFront, but the source of truth is
local: `alerts.json` and `revisits.json` live on the machine that runs
`alert check`, which has no inbound connectivity (WSL behind home NAT). The page
can't write to those files, and the machine can't be reached to ask it to.

So a change has to be **queued** somewhere both sides can reach, then applied
locally by the same code the CLI uses.

## Architecture

```
browser ──POST /api/ops──▶ CloudFront ──▶ Lambda (validate, authorize)
                                             │ SendMessage
                                             ▼
                                         SQS FIFO queue
                                             │ ReceiveMessage (long poll)
                                             ▼
local worker: `ops pull` ──apply──▶ alerts.json / revisits.json
             │                                   │
             └── results + republish ◀───────────┘
                     │
                     ▼
            dashboard.json (opResults) ──poll──▶ browser shows applied/failed
```

### Why SQS rather than an S3 "inbox" prefix

- **The site publisher would delete it.** `publishSite` removes every remote key
  that isn't in the local `site/` directory, so an inbox in the site bucket
  gets wiped on the next publish. A second bucket avoids that, but then:
- **Listing S3 to poll** is billed per request and gives no ordering. SQS long
  polling (20s) is ~4,300 requests a day, inside the free tier, and hands
  messages over within seconds of arrival.
- **FIFO with `MessageDeduplicationId` = op id** gives ordering and makes a
  double-clicked button, or a browser retry, a no-op for free.

### Why route `/api/*` through the existing CloudFront distribution

Same origin as the page, so no CORS configuration and no second hostname. Add a
second origin (the Lambda Function URL) and a cache behavior for `/api/*` with
caching disabled and `POST` allowed.

## Authorization — required before any of this ships

The site is currently public (no basic auth). A public read-only page is fine; a
public **write** endpoint is not. Anyone who found the URL could rewrite or
delete alerts.

Recommended: **an ops token**, independent of basic auth.

- A long random secret, `OPS_TOKEN`, stored in the Lambda's environment (via a
  `NoEcho` stack parameter) and nowhere in the site.
- The page asks for it once ("Unlock actions"), keeps it in `localStorage`, and
  sends it as `Authorization: Bearer …`. The Lambda compares in constant time.
- Without a token the page stays exactly as it is today: read-only, with
  copy-command buttons.
- Rotating it is one stack update; every browser re-prompts.

Alternative: turn `EnableBasicAuth` back on and trust anyone past the prompt.
Simpler, but it couples reading to writing and puts the password in function
code. The token is still worth having on top.

Also: rate-limit in the Lambda (a few ops per minute is plenty for one person),
and cap body size.

## Operation schema

One JSON document per change. The browser generates the id.

```jsonc
{
  "id": "01J8…",                 // ULID from the browser; idempotency key
  "type": "revisit.apply",
  "createdAt": "2026-09-12T15:04:05.000Z",
  "target": { "revisitId": "4bd864cb" },
  "params": { "level": 93 },     // optional per type
  "expect": {                    // what the page saw when you clicked
    "revisitStatus": "open",
    "alertLevel": 86
  }
}
```

`expect` is the conflict guard. The page renders from a snapshot up to a few
minutes old; if the local state no longer matches (the revisit was dismissed
from the CLI, or a newer trigger moved the level), the worker **rejects** the op
with a reason rather than applying it to something you weren't looking at.

The Lambda validates shape and types only. All semantic checks happen in the
worker, against real state.

## Operations, in build order

| # | Type | Target / params | Notes |
|---|---|---|---|
| 1 | `revisit.dismiss` | `revisitId` | Simplest; exercises the whole pipe. |
| 2 | `revisit.apply` | `revisitId` | Uses the entry's `suggestedLevel`. This is the ~4.6 re-arms/day. |
| 3 | `revisit.apply` + `params.level` | `revisitId`, `level` | Apply with an edited level. Needs `--level` on the CLI too. |
| 4 | `alert.snooze` | `alertId`, `until` | Needs a **new field** (see below). |
| 5 | `alert.remove` | `alertId` | Sets `status: "cancelled"`, same as `alert remove`. |
| 6 | `alert.add` | `symbol`, `level` \| (`near`, `trailPercent`) | Side is inferred against a live quote, so only the worker can do it. |
| 7 | `quiet.remove` (bulk) | `alertIds[]` | Frees alert slots. Needs `alertId` on quiet rows (below). |

Holdings import, seeding, and tuning stay CLI-only: they're file-based and rare.

## Code changes this needs

### 0. Pull the command bodies out of `cli.ts` first

`cmdRevisitResolve` calls `process.exit(1)` and `console.log` inline. The worker
can't use that. Refactor each operation into a pure function in
`src/ops/apply.ts` that takes stores, returns an `OpResult`
(`{ ok: true, message } | { ok: false, reason }`), and doesn't touch the
filesystem. Then:

- the CLI commands become thin wrappers (load, call, save, print), and
- the worker is the same wrappers driven by queue messages.

This is the step that keeps web-applied and CLI-applied changes identical. Do it
with tests before any AWS work.

### Snooze cannot reuse `mutedUntil`

`mutedUntil` looks like a snooze field, but the engine owns it. It suppresses
volume re-fires, `checkAlerts` resets it on every trigger (`engine.ts` sets it
to `muteUntilFor(...)` or `null`), and `revisit apply` clears it. A user
snooze stored there would be silently overwritten by the next trigger.

Add `snoozedUntil: string | null` to `BaseAlert`, default it in
`normalizeAlert`, skip snoozed alerts in `checkAlerts`, and show "snoozed until
…" on the page. Fixtures will need the field (`npm test` will list them).

### Dashboard document additions (shared with the Kindle renderer)

- `quietWatches` is `string[]`. Bulk removal needs ids, so change it to
  `{ alertId, symbol, note }[]`. Update `renderDashboard` and the page.
- `RevisitRow` needs the alert's current `level` for `expect.alertLevel`.
- Add `opResults: { id, ok, message | reason, appliedAt }[]` (most recent ~50).
  Add it to `VOLATILE_KEYS`? **No.** A result is an event and *should* trigger a
  publish.

### Level validation for edited levels and new alerts

Round before comparing against the live price (see CLAUDE.md, `holdings cover`):
a level that rounds onto the current price has no side and `addAlert` rejects
it. Return that as a readable rejection, not a thrown error.

### Worker: `ops pull`

```
node dist/cli.js ops pull [--wait 20] [--max 10]
```

1. Long-poll SQS for up to `--wait` seconds.
2. For each message in order: parse, check `expect`, apply via `src/ops/apply.ts`,
   save the stores, append the result to `ops.log.jsonl` (gitignored; the local
   audit trail), then delete the message.
3. Delete a message only **after** the stores are saved. A crash mid-apply
   redelivers it, and the op id makes a repeat detectable in `ops.log.jsonl`.
4. If anything was applied, the next `dashboard --publish --skip-unchanged`
   publishes, since the fingerprint changes.

Add it to `scripts/check-and-publish.sh` **before** `alert check`, so an applied
level is what the check evaluates:

```bash
node dist/cli.js ops pull --wait 0
node dist/cli.js alert check
node dist/cli.js dashboard --site site --publish --skip-unchanged --quiet
```

Latency is then the cron interval (~2 min). If that feels slow, a separate
long-running `ops pull --loop` could publish immediately after applying, which
brings it down to a few seconds. Start with cron.

### Page

- An "Unlock actions" control that stores the token. Real buttons appear only
  when a token is present; the copy-command buttons stay as the fallback.
- On click: POST, then mark the row **pending** (kept in `localStorage` by op
  id so a reload doesn't lose it). Clear it when `opResults` carries that id.
  Show a toast for a rejection, with its reason.
- Apply-with-edit: an inline number field pre-filled with `suggestedLevel`.
- Add alert: symbol + level, or symbol + trail %, in a small form above the queue.
- Confirm destructive ops (remove, bulk remove) with a second click, not a modal.

## Infrastructure additions (`infra/cloudformation.yaml`)

- `OpsQueue`: `AWS::SQS::Queue`, FIFO, content-based dedup off (the op id is the
  dedup id), 4-day retention, plus a dead-letter queue after 5 receives.
- `OpsFunction`: Node.js Lambda with a Function URL (`AuthType: NONE`; the
  token check is in code). IAM: `sqs:SendMessage` on the queue only.
- A second CloudFront origin plus a `/api/*` cache behavior (managed
  `CachingDisabled` policy, `AllowedMethods` including POST).
- The publisher IAM user gains `sqs:ReceiveMessage` and `sqs:DeleteMessage` on
  the queue, and the worker reads `OPS_QUEUE_URL` from `.env`.
- All of it behind an `EnableOps` condition, like `EnableBasicAuth`, so the
  current read-only stack is unchanged until it's turned on.

Cost at one user's volume: effectively zero (SQS, Lambda, and Function URL
requests all sit inside the free tiers).

## Testing

- `src/ops/apply.ts`: unit tests per op, including every rejection (`expect`
  mismatch, already resolved, no suggested level, non-static alert, level
  rounds onto price, unknown symbol).
- Idempotency: applying the same op id twice changes nothing the second time.
- Lambda handler: bad token → 401, malformed body → 400, valid → `SendMessage`
  called with the op id as dedup id (mock the SQS client).
- Worker: a message is deleted only after the store write succeeds (make the
  write throw, assert no delete).
- `ops apply --file op.json` for trying an op locally with no AWS involved.

## Phases

1. **Refactor**: `src/ops/apply.ts` + tests; CLI commands become wrappers. No
   user-visible change.
2. **Pipe**: queue, Lambda, token, `ops pull`, `opResults`, with dismiss and
   apply only. This proves the whole loop.
3. **Edit and snooze**: `apply --level`, `snoozedUntil`.
4. **Remove, add, quiet cleanup**: the document shape changes for quiet rows.

## Open questions

- Is ~2 minutes from click to applied acceptable, or is `ops pull --loop` worth
  running from the start?
- Should snooze offer fixed choices (until tomorrow's open, 1 week) or a date
  picker? Fixed choices are easier to use on a phone.
- Should the page ever *undo* (e.g. revert an apply using `appliedFrom`)? Cheap
  to add once apply records its previous level, which it already does.
