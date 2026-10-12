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
  (ETFs often don't); a symbol is never left out.
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

Symbols are passed to Schwab unchanged. Whether Schwab wants `BRK.B` or `BRK/B`
for a class share has **not** been verified against the live endpoint. Check it
with `equity-watch beta BRK.B BRK/B` once a login is fresh: the one that is `null`
is the wrong form, and the consumer should ask for that form.

## Still to confirm against a live login

Not verifiable offline: that ETFs such as IWM and SPY return a beta (a null for a
symbol the consumer needs means it cannot be beta-weighted), which of `BRK.B` and
`BRK/B` Schwab accepts, and that Schwab's figure really is 5-year monthly. The
`definition` field repeats that last claim from an old code comment; Schwab's
documentation was not consulted. One run answers all three:
`equity-watch beta AAPL IWM SPY BRK.B BRK/B` (JSON to the terminal, nothing written).

## Running it

Run it after the weekly `schwab-login`, and on whatever cadence the consumer's
staleness limit needs. In Docker see [`docker/README.md`](../docker/README.md).
Where the file lands is a deployment choice (a path both containers can see).
