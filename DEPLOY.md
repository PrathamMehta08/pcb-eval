# Deploying

The page is static. Only the review talks to a model, and it does that through
one serverless function, so the key stays on the server and no visitor needs an
account.

## What ships

```
dist/pcb-eval.html   the built page, committed on purpose
api/review.mjs       the proxy, served at /api/review
vercel.json          rewrites / to the built page
```

`dist/pcb-eval.html` is committed rather than built on Vercel. Building it needs
Python and the KiCad-derived board JSON, and the board changes about never, so
building on every deploy would buy nothing and add a way for deploys to fail.

**Rebuild after touching anything in `site/`:**

```bash
.venv/Scripts/python.exe tools/build_site.py
.venv/Scripts/python.exe tests/run.py
```

Step 11 of the suite checks the built file carries its own doctype, head, body
and charset, calls `/api/review` rather than the artifact runtime, and has no key
baked into it.

**`.mjs`, not `.js`.** Without a `package.json` declaring `"type": "module"`,
Vercel treats a `.js` function as CommonJS and `export default` is a syntax
error. The extension says ESM without adding a package.json that would confuse
build detection on an otherwise static repo.

## Setting it up

1. Push to GitHub.
2. vercel.com → **Add New Project** → import the repo. No framework, no build
   command, no output directory.
3. **Settings → Environment Variables**: `GROQ_API_KEY`. Optional, all with
   working defaults: `GROQ_MODEL`, `GROQ_BASE_URL`, `IP_PER_HOUR`, `IP_PER_DAY`.
4. Redeploy. Environment variables do not reach a build that already happened.

After that every push deploys.

## Where the real limit lives

**Set a spending limit in the Groq console. That is the guard that matters.**

Serverless functions have no persistent disk and no shared memory. The counters
in `review.mjs` live inside one warm instance, vanish on a cold start, and are
not shared with the instance beside it. They shape ordinary use. They are not a
spending guarantee and must not be relied on as one.

The Groq limit is enforced by the party doing the billing. It survives cold
starts, applies across every instance at once, and cannot be routed around.

| layer | stops | trustworthy |
|-------|-------|-------------|
| Groq spending limit | the bill | yes |
| per-IP hourly, 40 calls (~5 reviews) | hammering the button | while the instance is warm |
| per-IP daily, 160 calls (~20 reviews) | coming back all day | while the instance is warm |
| browser cooldown, 5-review count, board-hash cache | accidental repeats | no, `localStorage` clears |

A full sweep of the harness costs about nine cents, so a $2 ceiling is roughly
twenty complete evaluations, or a few hundred single reviews from the page.

If it ever draws enough traffic for the per-instance counters to matter, the fix
is a shared store such as Upstash Redis. Not worth the signup before there is
traffic to justify it.

## Client IP

`review.mjs` reads `x-forwarded-for`. On Vercel the platform sets that header
itself and overwrites whatever the client sent, so the first entry is the real
caller.

This is the opposite of generic shared hosting, where the same header is
client-supplied and trusting it lets anyone mint a fresh identity per request.
It is safe here specifically because the platform writes it.

## Failure behaviour

Every failure returns JSON carrying a `code` the page turns into copy:

| code | meaning |
|------|---------|
| `unconfigured` | `GROQ_API_KEY` unset, or set after the last deploy |
| `rate_limited` | an IP limit, or Groq throttling |
| `bad_json` | the model answered with something unparseable |
| `upstream_error` | anything else, including the spending limit being reached |

The board editor depends on none of it. With no function reachable at all the
page still renders, edits, logs, draws the ratsnest and reports plainly that the
review is unavailable.

## The reasoning model

`gpt-oss-120b` spends its completion budget thinking before it answers. Too
small a `max_completion_tokens` and `content` comes back empty with
`finish_reason: "length"`. The function sets 2600 and returns a specific message
if it still happens, rather than a generic upstream error.
