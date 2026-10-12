# `equity-watch beta`

Writes Schwab's beta for a list of symbols as a small JSON file, so a program
with no Schwab login of its own (the options-spread report, run from another
container) can read it. The consumer reads the file on a cron and never talks to
Schwab.

```sh
equity-watch beta AAPL IWM --out betas.json
equity-watch beta --symbols-file watchlist.txt            # JSON on stdout
equity-watch beta MSFT --symbols-file watchlist.txt --out /data/betas.json
```

Symbols come from the arguments, from `--symbols-file`, or both. The file is
plain text, one symbol per line; blank lines and `#` comments (whole-line or
trailing) are ignored. Symbols are trimmed, uppercased and de-duplicated. With
none at all the command prints a usage line and exits 1.

Without `--out` the JSON goes to stdout and nothing else does. With `--out` the
file is written there. Progress and summaries go to stderr either way.

## The file

```json
{
  "schema": "equity-watch/betas@1",
  "generatedAt": "2026-10-12T19:30:00.000Z",
  "source": "schwab instruments fundamental",
  "definition": "Beta as computed by Schwab: 5-year monthly, against the market",
  "betas": { "AAPL": 1.21, "IWM": null }
}
```

- Every requested symbol is a key. `null` means Schwab has no beta for it
  (some instruments don't; ETFs such as IWM and SPY do); a symbol is never left out.
- `generatedAt` is always present. The consumer decides from it when the file is
  too old to use, so a stale file is the reader's call, not something this
  command guards against.
- The schema string changes (`@2`) if the shape ever does. Adding a field would
  not bump it; removing or renaming one would.

## What it promises

| Situation | Result |
|---|---|
| Some symbols have no beta | File written, exit 0, `2 of 30 had no beta: IWM, XYZ` on stderr |
| Every symbol is null | **Nothing written**, existing file kept, exit 1 |
| Schwab answers 401, 403, 429 or 5xx | Run fails, nothing written, existing file kept, exit 1 |
| Login expired or never done | Nothing written, exit 3 (the code the scheduled scripts already branch on) |
| Credentials missing | Exit 1 with the usual "Missing Schwab credentials" message |
| `--out` unwritable | Exit 1, existing file kept |

The file is written to a temp file in the same directory and renamed over the
target, mode 0644, so a reader sees the old file or the new one and never half
of either. The directory must exist.

A throttled or failing request aborts the run instead of becoming a `null`:
`getBeta` returns null for every non-OK response, so a 429 would otherwise be
published as "Schwab has no beta for AAPL". The command uses `getBetaStrict`,
which throws on 401, 403, 429 and 5xx and keeps null for the rest (404 and the
like, which do mean "no data"). The all-null rule above is the second line of
defence for failures that still come back as plain null.

An instrument in Schwab's answer counts only if it names this symbol
(compared ignoring `.`, `/` and `-`, so `BRK.B` matches `BRK/B`); one that names
none is accepted. Without that check a different instrument returned first would
have its beta filed under the requested key.

## No cache

Betas are fetched fresh on every run, through the provider's usual rate limiter.
The command neither reads nor writes `.cache/beta/`: that cache, which the
analysis and the holdings page use, never expires. It is right for tuning a
breakout check and wrong for a number a position is sized by, because a beta
that was cached once would be served for ever.

## Symbol format

Symbols are passed to Schwab unchanged, and the key in the file is the symbol as
requested. Verified live on 2026-10-12: class shares need the **slash**. `BRK/B`
returned a beta and `BRK.B` returned null. Ask for `BRK/B`, not `BRK.B`.

An instrument in Schwab's answer counts only if it names this symbol
(compared ignoring `.`, `/` and `-`, so `BRK.B` matches `BRK/B`); one that names
none is accepted. Without that check a different instrument returned first would
have its beta filed under the requested key.

## No cache

Betas are fetched fresh on every run, through the provider's usual rate limiter.
The command neither reads nor writes `.cache/beta/`: that cache, which the
analysis and the holdings page use, never expires. It is right for tuning a
breakout check and wrong for a number a position is sized by, because a beta
that was cached once would be served for ever.

## Symbol format

Symbols are passed to Schwab unchanged. Whether Schwab wants `BRK.B` or `BRK/B`
for a class share has **not** been verified against the live endpoint. Check it
with `equity-watch beta BRK.B BRK/B` once a login is fresh: the one that is `null`
is the wrong form, and the consumer should ask for that form.

## Still to confirm

Checked live on 2026-10-12: ETFs do return a beta (IWM 1.14, SPY 1.01), and
`BRK/B` works where `BRK.B` does not. Not yet confirmed: that Schwab's figure is
really 5-year monthly. The `definition` field repeats that from an old code
comment, and Schwab's documentation was not consulted.

## Running it

By hand: `equity-watch beta --symbols-file <list> --out <file>`, as in the examples
at the top. The file's reader, not this command, decides when it is too old.

In Docker it is a scheduled job. `docker/run-beta.sh` reads
`/shared/underlyings.txt` and writes `/shared/betas.json`, weekdays at 08:05 and
14:05 (`docker/crontab`), at 30 Schwab requests a minute so it can overlap the
15-minute check without breaching Schwab's 120. It does not touch the check's
heartbeat or `HEALTHCHECK_URL`. A failed run leaves the old file and the next
scheduled run tries again; a lapsed login logs `login expired, keeping the old
betas` (exit 3) until the weekly `schwab-login` is repeated. The shared
directory's setup (mounted as a directory, `:z`, owned by uid 1000) is in
[`docker/README.md`](../docker/README.md#sharing-betas-with-another-container).
