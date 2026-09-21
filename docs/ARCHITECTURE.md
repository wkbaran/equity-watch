# Architecture and security

How the dashboard's editing round-trip works and what it does and doesn't protect.
Everything here is optional: with no stack deployed, the CLI and the local JSON view
work exactly the same.

## State is local; the cloud is a mailbox

`alerts.json`, `holdings.json`, `revisits.json`, and `ops.log.jsonl` live only on
the machine that runs the checks. They are never uploaded. AWS holds a rendered copy
of what the machine last published, plus a queue of changes waiting to be collected
— and nothing in AWS can reach the machine:

```
  PUBLISH  (machine → browser)         QUEUE  (browser → machine)

  dashboard --publish                  browser
       │ PutObject                          │ POST /api/ops + Bearer token
       ▼                                    ▼
  S3 bucket (private)                  CloudFront   (/api/* behavior)
       │ OAC, SigV4                         │
       ▼                                    ▼
  CloudFront   (default behavior)      Lambda   (token + shape check only)
       │ GET, public                        │ SendMessage
       ▼                                    ▼
  browser                              SQS FIFO queue
                                            │ Receive / Delete
                                            ▼
                                       ops pull   (next scheduled check)
```

One CloudFront distribution serves both, with the S3 bucket and the Lambda as two
origins split by path.

Both cloud paths are one-way. The machine pushes the site out and pulls ops in; it
never listens. That is the whole reason there is **no "apply now" button** — a queued
edit lands at the next scheduled check, and the page's job is to say when
(`opsNextCheckAt`, or the cadence `ops pull` measured for itself). An always-on local
watcher long-polling SQS was considered and rejected; see the header of
`src/ops/pull.ts`.

Everything cloud-side is optional. With no stack deployed, the CLI and the local JSON
view work exactly the same, and `ops pull` prints "Ops disabled" and exits 0.

## Unlocking editing

**Unlock editing** in the header prompts for the stack's `OpsToken` and keeps it in
`localStorage`, per browser. The first thing it does with that token is *not* send it
anywhere — it fetches `vault.json` and tries to decrypt it. AES-GCM authenticates, so
a wrong token fails the decrypt, and the page says so and clears it before a single
op is queued. Opening the vault **is** the token check.

Unlocking turns on two things at once: holdings become visible (they are otherwise
absent, not hidden), and the editing controls appear — add and edit alerts, remove
alerts, dismiss queue entries, add/edit/remove lots, remove a position, add and
remove stops. **Lock editing** drops the token and the decrypted holdings from
memory.

## Holdings are encrypted in the browser, not hidden by the page

The site has no login by default, so `dashboard.json` is readable by anyone with the
URL. Two separate mechanisms keep positions off it:

- **`web.holdings` off** — `siteDocument` empties the holdings rows before writing
  *and* before fingerprinting. They are not in the published file at all. A
  `heldPosition` boolean is the only holdings fact allowed to travel in a public
  document, so a headline can say "Holding MKS crossed below 110" without revealing
  size or value.
- **`vault.json`** — positions, lots, and stops sealed with **AES-256-GCM** under a
  key derived from the ops token (`src/web/vault.ts`), decrypted in the browser by
  WebCrypto after unlocking.

The key is `SHA-256("equity-watch/holdings-vault/v1 " + token)` — a plain hash with a
context prefix, no PBKDF2 or Argon2. That is deliberate and it rests on one
assumption: the token is 256 random bits, not a human-chosen password, so there is
nothing to stretch. The Lambda refuses to serve any request while `OpsToken` is under
32 characters, which is what keeps that assumption true. **Generate it with `openssl
rand -hex 32`; a memorable token silently makes the vault brute-forceable.**

Every seal uses a fresh IV, so the ciphertext changes on every build — which is why
the publish fingerprint covers the vault's *plaintext* and never the sealed document.

## Queueing a change: Lambda → SQS → `ops pull`

The page POSTs to `api/ops`, same-origin through the same CloudFront distribution (so
no CORS), with `Authorization: Bearer <token>`. That path routes to a Lambda Function
URL instead of S3.

The Lambda (inline in `infra/cloudformation.yaml`, so it can't import from `src/`)
checks **only the token and the envelope**: POST only, body ≤ 16 KB, valid JSON, an op
id of 8–64 `[A-Za-z0-9-]`, a known op type, the target key that type requires, and
`params`/`expect` as objects. The token comparison hashes both sides with SHA-256
before `timingSafeEqual`, so it is constant-time whatever the lengths. Then it sends
one SQS message and returns `202`.

The op types are `alert.add`, `alert.edit`, `alert.remove`, `revisit.dismiss`,
`lot.add`, `lot.edit`, `lot.remove`, `position.remove`, `stop.add`, and `stop.remove`.
Adding another means updating the Lambda's inline `TARGET_KEY` and redeploying the
stack, or the page gets "Unknown op type"; `tests/lambdaContract.test.ts` asserts the
template and `OP_TYPES` agree.

Nothing semantic is checked in the Lambda — whether the alert exists, whether the
level makes sense against a live quote, whether the lot still looks the way the page
showed it. All of that happens on the machine, against real state, through the same
validators (`src/ops/validate.ts`) and engine functions the CLI uses. A check added to
only one of the two would let the page accept what the CLI refuses.

The queue is **FIFO** with a single message group, so ops apply in the order they were
made — a later edit may target an alert an earlier add creates. The op id is the
deduplication id, which turns a double-click into one message, but **SQS dedup is not
what makes this safe**: it lasts five minutes, and an add is not idempotent. `applyOp`
checks `ops.log.jsonl` for the op id first and returns the logged result instead of
applying again, and a message is deleted only after its result is logged. A crash in
between redelivers it and the log absorbs the repeat.

The two failure modes are treated differently on purpose:

- **A rejection is a result.** Bad input, a stale page, or the engine saying no gets
  logged, deleted, and published in `opResults` so the page can show what happened.
  `expect` is the conflict guard: an alert whose condition changed, or a lot that no
  longer matches what was on screen, is rejected rather than applied to something that
  isn't what you saw.
- **An exception is not.** A lapsed Schwab login throws, `pullOps` stops at that op,
  and it and everything after it stay queued for the next run.

A message that fails 40 receives goes to a dead-letter queue; the main queue keeps
messages 4 days, the DLQ 14.

## The worker: a scheduled script, not a daemon

Nothing listens on the queue. `ops pull` is an ordinary CLI command, and the thing
that runs it is the same scheduled script that does the periodic check —
`scripts\check-and-publish.ps1` under Windows Task Scheduler in the current setup
(`scripts/check-and-publish.sh` for cron/WSL; [`SCHEDULING.md`](SCHEDULING.md) has the
registration). Weekdays, every 15 minutes, from 01:55 to about 18:15 Mountain, which
covers 04:00–20:00 Eastern.

Each run is the four-step loop in the [README](../README.md#how-it-works): `ops pull`
is where the queue is drained, and the final publish is where results go back out.

If `ops pull` or `holdings cover` fails, the script logs it and carries on with the
check — failed ops stay queued — whereas a failing `alert check` stops the run.

`ops pull` drains until the queue is empty rather than taking a fixed batch; `--max`
is an opt-in valve for manual runs. Overrunning Task Scheduler's ten-minute kill is
safe for exactly the reason a crash is — whatever was applied is already logged and
deleted, and the next run finishes the rest.

For a one-off, `ops apply --file op.json` applies a single op with no AWS involved.

## When the Schwab login expires

Schwab refresh tokens last **7 days**, and only the interactive browser flow
(`schwab-login`) renews one — there is no unattended path. So roughly weekly the
scheduled task wakes up with no way to fetch a quote. The whole run copes:

- **Exit code 3 means "the login expired", everywhere.** A missing token file counts
  too: same remedy. Both scheduled scripts branch on it.
- **`ops pull` checks the login before it receives anything.** Receiving is the first
  irreversible step: an SQS message handed out is invisible until it is deleted or
  released, so a drain that discovers a dead login mid-batch would leave the queue
  *looking empty* for the visibility timeout. Instead the preflight runs first and the
  drain returns `blocked` without touching the queue. Only an *expired* failure
  blocks; Schwab being down is transient, and with no Schwab credentials configured at
  all the check is skipped entirely (removes, dismisses, and holdings ops need no
  market data).
- **The scripts skip ahead and publish anyway**, then exit 3 so the healthcheck ping
  still reads as a failure. `dashboard` tolerates a dead login on its own: it catches
  the quote failure and renders without live prices.
- **The page stops promising checks it can't make.** It says "checks paused, login
  expired" instead of counting down to a run that will evaluate nothing, and names the
  command to run — because nothing can push to the machine, there is no button that
  could work.

The fix is always the same, on the machine that runs the checks:

```bash
node dist/cli.js schwab-login
```

## Closing the loop

The run that applies an op is also the run that publishes, so the answer travels back
to the browser in the next `dashboard.json`:

```
browser  ──POST──►  Lambda ──►  SQS  ──►  ops pull ──►  applied to alerts.json
   ▲                                          │              (result → ops.log.jsonl)
   │                                          ▼
   └──────── GET dashboard.json ◄──── dashboard --publish  (opResults)
```

The page keeps its own list of what it sent, in `localStorage`, so a reload doesn't
lose track of what's waiting. Each pending row is matched against `opResults` by op id
and resolves into applied or rejected, with the rejection's reason shown. Unlike the
price- and clock-derived fields, `opResults` is deliberately **kept in** the publish
fingerprint: a new result must be able to force a publish, or a quiet run would
swallow it and the page would never learn its edit landed.

Two details stop that from leaving rows stuck forever:

- **A watermark.** A clean drain records when it started, published as
  `opsProcessedThrough`. Everything queued before that has been applied, so the page
  retires older pending rows even when their results have aged out of the published
  list (`opResults` is capped, and a burst can exceed the cap).
- **A measured cadence.** `ops pull` records its own drain history and publishes the
  **median** gap as `opsIntervalMinutes` (a mean would be skewed by the ~8-hour
  overnight gap), which is how the page counts down to "applies in ~12 min" and, past
  a grace factor, warns that checks have stopped. The Windows script does better when
  it can: it reads its own `(Get-ScheduledTaskInfo).NextRunTime` and passes it as
  `--next-check`, so the page can say "next check 1:55 AM" — already accounting for
  the nightly gap rather than promising 15 minutes at 6pm. The cron path passes none
  and lives on the measured cadence alone.

## Encryption and access control

- **In transit.** CloudFront only; viewers are redirected to HTTPS and `/api/*` is
  HTTPS-only, TLS 1.2 minimum on the custom domain.
- **At rest in S3.** Objects get SSE-S3 (AES-256, AWS-managed keys). Note that this is
  **S3's account-wide default, not something this template configures** — and it is
  worth being clear about what it does and doesn't buy you. It encrypts the bytes on
  AWS's disks; it does **not** restrict readers. Anyone who can GET an object through
  CloudFront gets plaintext, because S3 decrypts transparently for authorized reads.
  That is exactly why holdings get a second, client-side layer in `vault.json` rather
  than relying on bucket encryption.
- **The bucket is private.** All four public-access blocks are on, and the bucket
  policy grants `s3:GetObject` only to the `cloudfront.amazonaws.com` service
  principal, conditioned on the caller being a distribution in this account. Reads go
  through Origin Access Control (SigV4); there is no public bucket URL.
- **Least privilege on both identities.** Beyond writing its own logs, the Lambda's
  role can do one thing: `sqs:SendMessage` to that one queue. (Its log group is
  declared explicitly, with 14-day retention, rather than left to Lambda to create and
  keep forever.) The publish user can write and delete objects in the bucket and
  *receive and delete* from the queue — it has no `SendMessage`, so the publishing
  credentials can't forge an op.
- **No CloudFront invalidation.** This publishes every few minutes, and invalidations
  past 1,000 paths/month are billed, so everything is uploaded with
  `Cache-Control: no-cache` instead.
- **Optional basic auth** (`EnableBasicAuth=true`) puts a CloudFront Function in front
  of the site. It is required before turning on `web.holdings`, since that puts real
  numbers in `dashboard.json`. It is deliberately **not** applied to `/api/*`: the
  Lambda's token check is the gate for writes.

## What the token protects, and what it doesn't

One secret does two jobs — it opens the write queue and it decrypts holdings. That
keeps the design small, and it means a leak costs both. Worth knowing before you
decide what this is allowed to hold:

- **Reads of the dashboard are public by default.** Live alerts, levels, triggers,
  headlines, and which symbols you hold are visible to anyone with the URL. Only
  sizes, basis, market value, and stops are withheld. Turn on basic auth if that isn't
  acceptable.
- **The Lambda URL is public** (`AuthType: NONE`) with the bearer token as the only
  gate. Unauthorized requests are refused with a 401, but they still invoke the
  function — there is no WAF or rate limiting, so the exposure is billing and log
  noise, not writes.
- **The token sits in `localStorage`.** Any XSS on the page, or anyone with the
  browser profile, gets both write access and your holdings. Lock editing on a machine
  you don't control.
- **Rotating it is a two-step.** Redeploy the stack with a new `OpsToken`, then
  republish so `vault.json` is resealed under the new key. Browsers holding the old
  token fail the vault decrypt and are prompted again.
- **The publish user's secret key appears in the stack outputs**, so anyone with
  CloudFormation read access to the account can retrieve it. The basic-auth password is
  likewise embedded in the CloudFront Function's source.
- **The bucket is not versioned.** A bad publish overwrites the good one; the fix is to
  publish again, since every document is regenerated from local state.
- **Queued ops are not encrypted end-to-end.** A message carries symbols, levels, and —
  for a lot — share counts and basis, readable by anyone with queue access in your AWS
  account. None of that reaches the public site: a holdings op *result* names the
  symbol and the field but never a number, and a test asserts no holdings message
  contains a digit.
