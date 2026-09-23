# Design: Gyges vacancy-scraper HTTP 500 / captcha

**Date:** 2026-09-23
**Status:** design only. No application code in this change.
**Task:** FlowSync #3097 (project Scraper)
**Deploy under discussion:** `https://scraper-mtx0os3l.on-forge.com` (`GET /health` = 200)
**Caller:** Gyges (`app.gyges.nl`, Forge site id 26) → `POST /api/scrape`

This document records how a scrape failure becomes `{"error":"Scrape failed"}`, which exceptions can produce that body, and the contract Gyges should receive so a bot-block is distinct from a scraper bug.

## Incident

Since about 13:45 CEST (11:45 UTC) on 2026-09-23, Gyges sees HTTP 500 with body `{"error":"Scrape failed"}`.

| Domain | Reported result | Approx. latency |
| --- | --- | --- |
| `bas-hr.nl` | 500 | ~13s |
| `veluwsebron.nl` | 500 | ~4s |
| `odachterhoek.nl` | 500 | not timed |
| `improvement-it.nl` | 500 | not timed |

Ops fetched `bas-hr.nl` from outside the scraper and got a SiteGround captcha with HTTP 202. The morning Postgres "shutting down" event is treated as transient and is not the working explanation for this spike.

This design did not call the production scraper and did not read FlowSync credential 23.

## Goal

1. Name the code paths that delete the real exception, and give Forge log checks that confirm whether that exception was ever written down.
2. Separate three outcomes the API currently collapses: target bot-block, target/site failure, scraper bug (including the AI provider).
3. Propose a stable error body and HTTP status so Gyges can keep "our process is broken" red and treat "this domain blocked us" as a per-domain result.
4. Say which failures are safe to retry once, and which must fail fast.

## Non-goals

- Implementing the fix, adding fixtures, or changing runtime behavior in this PR.
- Solving captchas, rotating proxies, or presenting the HTTP client as a normal browser in order to get past SiteGround.
- Changing Gyges itself. Gyges has to start reading `code` before its monitor can go green on a block. That work lives in the Gyges repo.
- Redesigning ChatSync, Google Ads, LinkedIn Ads, or customer reviews. Those routes share the same mask; they are a follow-up question, not this incident.
- Changing the success JSON (`ScrapeResponse`) that Gyges already parses.
- Calling production with the live API key, or pasting secrets into logs.

## Current architecture

```
Gyges
  POST /api/scrape { domain, detailLimit? }
        │  Bearer API_KEY
        ▼
src/routes/scrape.ts          Zod request check, then orchestrator.scrape
        │
        ▼
src/services/orchestrator.ts  cache get → discovery → platform parser or AI → cache set
        │
        ├── src/services/cache.ts          Redis, else in-memory Map, TTL 24h
        ├── src/services/discovery.ts      sitemap, candidate URLs, homepage links
        │         │
        │         ▼
        │   src/services/scraper.ts        HTTP fetch, else Playwright Chromium
        ├── src/services/platforms/        only Recruitee is implemented
        └── src/services/ai-extractor.ts   Claude messages.create, then Zod
```

`src/index.ts` builds one `Orchestrator` (and a second `ScraperService` for the other products) and listens until SIGINT/SIGTERM. Fastify is constructed with `logger: false`.

### Request path for `POST /api/scrape`

1. **Auth.** `preHandler` in `src/routes/scrape.ts` compares `Authorization: Bearer …` to `API_KEY`. A mismatch sends 401 `{ error: "Unauthorized" }`. Gyges is past this check: the body ops saw is the 500 from the route `catch`, which only runs after the handler starts.
2. **Request schema.** `ScrapeRequestSchema` (`src/types/vacancy.ts`) requires a domain and `detailLimit` in `0..20` (default `0`). Failure here is a Zod error and becomes HTTP 400.
3. **Cache.** Key `vacancy:` + 16 hex chars of SHA-256 over `domain` plus, when `detailLimit > 0`, `:details:{n}`. A hit returns the stored JSON with `cached: true` and does not fetch.
4. **Discovery** (`DiscoveryService.findCareerPage`):
   - Sitemap URLs (`/sitemap.xml` and three alternates). `response.ok` keeps the body. HTTP 202 is inside `200–299`, so a captcha body is "ok" and is parsed for `<loc>`.
   - Up to five sitemap URLs that look career-related, via `scraper.fetch`.
   - Then `getCareerPageCandidates` (`src/utils/url.ts`): six guessed subdomains (`werkenbij{name}.nl`, `careers.`, `jobs.`, …) plus sixteen paths (`/vacatures`, `/careers`, `/jobs`, …). Fetched in batches of three with `Promise.allSettled`.
   - Then the apex URL, then up to three career links extracted from that HTML.
   - A page is accepted when `status < 400` and `looksLikeCareerPage` finds a substring such as `vacature`, `career`, `job opening`, `werken bij`.
   - Platform id is a substring of the URL or HTML: `recruitee`, `greenhouse`, `lever`, `workable`.
5. **Extract.**
   - If a platform id is set, `parseWithPlatform` runs. The switch only implements Recruitee. Greenhouse, Lever, and Workable return `null`, and the orchestrator falls through to AI.
   - AI is `AIExtractor.extract` with model id `claude-3-5-haiku-20241022` (`src/services/ai-extractor.ts`). The same id is used again for detail pages.
   - When the overview yields fewer than five vacancies, up to five department URLs are fetched. Those errors are caught.
   - `detailLimit` defaults to `0`. When it is above zero, per-vacancy detail errors are caught and the vacancy is returned without details.
6. **Store and return.** Both "career page found" and "career page missing" are written to the cache for 24 hours. The missing-page payload is HTTP 200, `hasVacancies: false`, empty `careerPageUrl`, `method: "ai"`.

### Fetch pipeline (`ScraperService.fetch`)

1. `fetchWithHttp`: 10s abort, `User-Agent: Mozilla/5.0 (compatible; VacancyBot/1.0)`, `Accept: text/html`. Any throw (timeout, DNS, TLS, reset) is discarded.
2. The HTTP result is kept only when `status === 200` and `needsJavaScript(html)` is false. `needsJavaScript` is true for short pages (`html.length < 1000`), thin text, or a few SPA markers.
3. Every other outcome falls through to `fetchWithPlaywright`: headless Chromium, Chrome 120 UA, `page.goto(..., { waitUntil: 'networkidle', timeout: 45000 })`, then a fixed wait of 3s, cookie-banner clicks, three half-second scrolls, and another 2s wait. One browser process is reused until `close()`. There is no `browser.isConnected()` check before `newContext()`.

A finished Playwright navigation therefore spends at least 6.5s in those waits after `goto` returns. `veluwsebron.nl` answering in ~4s did not finish that wait sequence.

### What Anthropic documents about the model id

`AIExtractor` calls `claude-3-5-haiku-20241022`. Anthropic's model deprecation table lists that id as **Retired**, deprecated 2025-12-19, retirement date **2026-02-19**, replacement `claude-haiku-4-5-20251001`. The same page states that requests to retired models fail.

Source: [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), read 2026-09-23.

The previous id in this file, `claude-sonnet-4-20250514`, is also listed as retired (2026-06-15). The switch to Haiku landed in `bf410b4` (2026-01-23).

That fact does not, by itself, prove the 13:45 spike. A hard failure on every AI scrape since February would have kept this monitor red for months, unless production is not running this build, Anthropic is still serving the id, or this morning's green checks were cache hits from the last 24 hours. Cache hits require a successful scrape inside that window. The log check below is how to tell those apart. The id is still a defect: the day the provider enforces retirement, every AI scrape becomes this 500.

`claude-haiku-4-5-20251001` is Active with "not sooner than 2026-10-15". Pinning it repeats this class of failure on a short horizon. A later section recommends an environment variable for the model id.

## Where errors are masked

The 500 body is produced in one place (`src/routes/scrape.ts`):

```ts
fastify.log.error(error);
reply.code(500).send({ error: 'Scrape failed' });
```

The same shape is copied in `src/routes/chatsync.ts`, `google-ads.ts`, `linkedin-ads.ts`, and `customer-reviews.ts` ("ChatSync scrape failed", and so on).

`src/index.ts` sets `logger: false`. Fastify 5 then builds a Pino logger at level `silent`. `fastify.log.error(error)` returns without writing. The `Error` object — name, message, stack, Anthropic status — is dropped on the floor. Nginx still records status 500 because the reply was sent.

There is no `setErrorHandler`. The route `catch` handles the rejection first, so Fastify's default handler never sees it either.

### Paths that swallow before the route

| Location | What is caught | What the caller observes |
| --- | --- | --- |
| `ScraperService.fetch` HTTP `catch` | Timeout, DNS, TLS, reset. No log line. | Playwright runs. |
| `fetchWithPlaywright` | Nothing. `goto` / launch / `newContext` rejects out of `fetch`. | Caller decides. |
| `DiscoveryService.findCareerPage` per URL, and homepage `catch` | Any `fetch` rejection, empty `catch`. | Next candidate. |
| Candidate batches | `Promise.allSettled`. | Rejection is ignored. |
| Sitemap fetches | Empty `catch`, and `if (!response.ok) continue`. | Next sitemap URL. HTTP 202 is kept. |
| End of discovery | No throw when every candidate fails. | `null`. |
| Orchestrator when `careerPage` is null | None. | HTTP 200, `hasVacancies: false`, **cached 24h**. |
| Department loop | `console.error`, then continue. | HTTP 200 if the overview succeeded. |
| Detail loop (`detailLimit > 0`) | `console.error`, then continue. | HTTP 200, vacancy without details. |
| `CacheService.get` / `set` | Redis errors. `get` returns null. `set` falls through to the in-memory Map. | Request continues. |
| `new Redis(url)` in the cache constructor | No `error` listener. | A connection `error` event can crash the process. That is a dropped connection or a daemon restart, not the JSON body ops captured. |

`console.log` / `console.error` do reach the Forge daemon log (`Found N career-related URLs in sitemap`, department failures, detail failures). The route-level exception does not.

### Throws that reach the route `catch`

Once `findCareerPage` returns, these are not caught inside the orchestrator:

- `AIExtractor.extract` — Anthropic SDK error, `Error('No JSON found in Claude response')`, `Error('Unexpected response type from Claude')`, `JSON.parse` `SyntaxError`, `new URL(...)` `TypeError`.
- `RecruiteeParser.parse` — `Could not extract company ID from Recruitee URL` when the page URL is not `https://{company}.recruitee.com`, or `Recruitee API error: {status}`. `detectPlatformFromHtml` sets the platform when the HTML merely contains the letters `recruitee`. The orchestrator then awaits `parse()` with the career-page URL.

### A second mislabel, for a different status

The route treats every `ZodError` as a bad client request (`src/routes/scrape.ts`):

```ts
if (error instanceof ZodError) {
  reply.code(400).send({
    error: 'Invalid request',
    details: error.issues
  });
  return;
}
```

`AIResponseSchema.parse` and `AIDetailSchema.parse` throw `ZodError` from the same `zod` package. An AI payload that is JSON but fails the schema becomes **HTTP 400** `Invalid request` with the schema `issues` in the body. The incident body is the 500 string, so the throw ops hit was not a `ZodError`. The split still has to be fixed, or the next provider quirk pages the wrong alarm.

### Why the observed body is exactly `{"error":"Scrape failed"}`

That string is the route `catch` for a non-Zod throw. It is not a Playwright message and not an Anthropic message. Latency still constrains where the throw happened:

- **~4s (`veluwsebron.nl`).** Shorter than the 6.5s of waits after a successful `goto`, and shorter than the 10s HTTP abort. This request left `orchestrator.scrape` via a throw on a path that never finished Playwright. The matching shape is: discovery accepted a page over plain HTTP (status 200, enough text), then `extract` or `RecruiteeParser.parse` threw.
- **~13s (`bas-hr.nl`).** Long enough for several fast HTTP responses (a 202 captcha is a completed response, not a 10s abort) and one partial browser attempt, or for one 10s HTTP abort plus a short throw. It is shorter than `networkidle`'s 45s timeout, so this sample did not sit out a full Playwright timeout. Discovery's `catch` / `allSettled` would keep walking candidates after a browser throw, so a browser throw alone ends as HTTP 200 with an empty vacancy list once the walk finishes. Ending at 13s with this JSON means an uncaught throw fired at that moment — the overview AI call or the Recruitee parser — after discovery had already returned a page.

A captcha page can be that "page". See H2.

## Root-cause hypotheses

Ranked for **this** 500 body. Captcha handling is required either way; it is not automatically the exception object inside the catch.

### H1 — AI extractor throws, and the route deletes the error

**Rank: most likely explanation of a 500 on several unrelated domains at once.**

`extract` runs for every accepted page that is not a successful Recruitee parse. The model id is retired on the provider's own table. An SDK error from `messages.create` is not a `ZodError`, so the route returns 500 and logs nothing.

This fits:

- Four domains failing together (shared dependency).
- `veluwsebron.nl` in ~4s: HTTP discovery plus one fast provider error.
- A red monitor keyed on HTTP status. Failures are not written to the success cache, so every Gyges poll misses cache and 500s again.

This does not fit cleanly:

- A first failure at 13:45 today, if the same check was green this morning on an uncached AI domain. That green check would mean the model id still returned a completion. Ask Remco which of those is true (open questions).

**Confirm in Forge logs.** Expectation from this code: the daemon log has **no** stack for the 500. A line `Found N career-related URLs in sitemap` can still be there, because discovery logs that before the throw. Department logs (`Found N department links`) appear only after `extract` returns, so their absence on a 500 is consistent with `extract` throwing.

After a later logging change, the line to look for is an Anthropic `not_found_error` / HTTP 404 naming `claude-3-5-haiku-20241022`, or a connection error to `api.anthropic.com`. `model_unavailable` versus `extractor_parse` versus a network timeout are different `reason` values in the contract below.

### H2 — HTTP 202 / challenge HTML is accepted as a career page, then the next step throws

**Rank: best explanation of `bas-hr.nl` specifically, and of a class of silent wrong 200s.**

`bas-hr.nl` answering HTTP 202 with a SiteGround captcha matches the code's blind spots:

- `fetch` keeps an HTTP result only for status 200. **202 always starts Playwright.**
- Discovery drops a page only when `status >= 400`. **202 is kept.**
- `looksLikeCareerPage` is a substring test. Challenge HTML that echoes the requested URL (`/vacatures`, `/careers`, `/jobs`) contains `vacature` or `career` and is accepted.
- The accepted HTML is sent to Claude. Combined with H1, that call throws and the client sees 500. If the model call succeeds, the client sees HTTP 200 with vacancies invented from the challenge text, or an empty list, and that payload is cached for 24 hours.
- Sitemap fetch uses `response.ok`. A 202 captcha body is parsed as XML.

`VacancyBot/1.0` is a declared bot UA. SiteGround's anti-bot is a known source of HTTP 202 plus an HTML challenge. Playwright then uses a Chrome UA from the same Forge IP, with `navigator.webdriver` patched over. That is not a captcha solver. A challenge that keys off datacenter IP or a real browser check fails again, after the 45s `networkidle` budget in the worst case.

**Confirm:** from a shell that is allowed to fetch the public site (no scraper API key):

```bash
curl -sS -D - -o /tmp/bas-hr-vacancybot.html \
  -A 'Mozilla/5.0 (compatible; VacancyBot/1.0)' \
  --max-time 20 \
  https://bas-hr.nl/vacatures
```

Record status, `content-type`, `set-cookie`, and whether the body contains `sgcaptcha`, `sg-captcha`, or the path `vacatures`. Repeat with a normal browser UA only as a comparison of the public page. Do not send `API_KEY` anywhere.

In the daemon log, H2 leaves the same gap as H1 until fetch classification is logged: discovery's "Found N career-related URLs" line, then the 500, with no error object.

### H3 — Recruitee false positive throws out of the parser

**Rank: plausible for a single domain, weak for all four.**

`detectPlatformFromHtml` returns `recruitee` when the HTML contains that substring. `RecruiteeParser.parse` then throws `Could not extract company ID from Recruitee URL` for a host that is not `{company}.recruitee.com`. The orchestrator does not catch it. The 500 is immediate after the page fetch, which fits a ~4s request.

Greenhouse / Lever / Workable do not throw; they return `null` and fall through to AI.

**Confirm:** after logging exists, `reason: parser_failed` and that message. Until then, the string will not be in the daemon log unless some other `console.error` printed it. The route does not.

### H4 — Playwright or Chromium failure during discovery

**Rank: real defect, wrong symptom for this JSON.**

Launch failure, `browser has been closed`, and `page.goto` timeouts reject `fetch`. Discovery catches those per URL. When every URL fails, `findCareerPage` returns `null` and the API responds **HTTP 200**, `hasVacancies: false`, and caches it for 24 hours. Gyges' status check stays green while the data is an outage.

A completed Playwright fetch cannot be the whole ~4s `veluwsebron.nl` call, because of the 6.5s of fixed waits.

**Confirm:** access log lines for these domains with status **200** and a small JSON body, in the same window as the 500s. That would mean some polls took the swallowed path. Daemon log may contain Playwright's own stderr (`browserType.launch`, `Executable doesn't exist`, `Target page, context or browser has been closed`) because Supervisor uses `redirect_stderr=true`. Those lines can exist even when the HTTP status is 200.

### H5 — Redis, Postgres, or a dead process

**Rank: poor fit for this body.**

`/health` does not touch Redis, Anthropic, or Chromium. HTTP 200 there only means the process is listening.

Cache `get`/`set` swallow Redis errors. The JSON ops received is written by the route `catch`, so the process was alive and the handler finished. An unhandled `error` event from `ioredis` (no listener today) crashes Node and shows up as nginx `upstream prematurely closed connection` or a daemon restart, typically **502**, not this JSON.

The morning Postgres shutdown stays out of this ranking unless those nginx lines appear at 13:45 CEST.

### How to confirm in Forge logs

Do this on the scraper server, not on the Gyges site (Forge site 26). The scraper host is the site whose domain is `scraper-mtx0os3l.on-forge.com`. Window: **2026-09-23 11:40–12:10 UTC** and the same clock in `Europe/Amsterdam` (13:40–14:10) if the server is on local time. This design did not SSH there.

Daemon stdout/stderr (Forge background process, Supervisor):

```bash
# Exact path is stdout_logfile in the daemon unit.
grep stdout_logfile /etc/supervisor/conf.d/daemon-*.conf

# Default Forge layout. User-isolation sites use /home/<user>/.forge/ instead.
ls -l /home/forge/.forge/daemon-*.log
```

Or `forge background-process:logs` from a Forge CLI session. The UI path is the server → background processes → log for the scraper's `npm start` process.

```bash
# Around the spike. Silent logger ⇒ no "Scrape failed" and no stack from the route.
grep -n -E 'career-related URLs|department links|Recruitee|not_found_error|claude-3-5-haiku|TimeoutError|browserType.launch|Target page' \
  /home/forge/.forge/daemon-<id>.log
```

Nginx, which does see the status the route sent:

```bash
# Access log: status, request time, bytes. The body is 24 bytes: {"error":"Scrape failed"}
grep 'POST /api/scrape' /var/log/nginx/scraper-mtx0os3l.on-forge.com-access.log

# Error log: empty of this 500 when the Node process returned the JSON itself.
# upstream prematurely closed  ⇒ process died (H5), a different symptom.
grep -E 'scraper-mtx0os3l|upstream' /var/log/nginx/scraper-mtx0os3l.on-forge.com-error.log
```

Forge's domain log name follows the site name. If the file is absent, the site's Nginx panel shows the path. `forge nginx:logs` and `forge nginx:logs access` print the same streams.

Reading guide:

| What you find | What it means |
| --- | --- |
| Access log 500, body size 24, error log quiet, daemon log without a stack | The route `catch` ran and `logger: false` discarded the exception. Matches the code as read. |
| Daemon line `Found N career-related URLs in sitemap` and no `department links` on that request | Discovery ran. `extract` did not return. Supports H1 or H2. |
| Playwright `browserType.launch` / `Target closed` and access log **200** | H4, the silent empty-result path. |
| nginx `upstream prematurely closed` at 13:45 | Process crash. Not the JSON 500. |
| A stack containing `not_found_error` or `Could not extract company ID` | Only possible if some other `console.error` printed it. The route will not have. |

Until the logging change in the recommendation is deployed, Forge cannot show the exception under this 500. That absence is the evidence, not a failed search.

## Options

### Option A — Log the exception, keep behavior

Enable a real logger and `console.error` or `request.log.error({ err }, ...)` in the route `catch`. Split AI `ZodError` from request `ZodError`. Leave discovery, Playwright, cache, and the HTTP status as they are.

- Gyges still sees 500 for every failure, so the monitor stays red for a captcha and for a model 404.
- The next spike is diagnosable from `daemon-*.log`.
- Small diff. Does not stop challenge HTML reaching Claude, and does not stop a failed discovery being cached as "no vacancies".

### Option B — Classify the fetch, fail fast on a block, typed errors, one safe retry

Recommended. Builds on A.

1. **Log first**, in the same implementation, so the first deploy that only needs to confirm H1 vs H2 already has a stack. Log `domain`, `stage`, `code`, `url`, target status, vendor marker, `err.name`, `err.message`. Omit HTML, `Authorization`, and `ANTHROPIC_API_KEY`.
2. **Typed `ScrapeFailure`** thrown from discovery, parser, and extractor. The route maps `code` → HTTP status and the JSON contract below. A bare `Error` or `SyntaxError` stays HTTP 500 `internal`.
3. **Classifier** in front of `looksLikeCareerPage` and in front of the AI call. Signals are listed in the next section. Challenge HTML is not a career page and is not sent to Claude.
4. **Playwright policy.** A classified challenge on the HTTP response gets **one** Playwright attempt per host, with a short timeout (10s, `domcontentloaded`), because some sites only challenge `VacancyBot` and then serve the page to a browser UA. A second challenge ends the host: apex/www challenge ends the scrape as `blocked`; a guessed subdomain (`werkenbij{name}.nl`, `jobs.`) is skipped. No stealth plugin and no captcha solve.
5. **Retry once** only for the cases in the retry table. No retry of a block, a 404, or a model 404.
6. **Cache.** Success and a genuine "no career page" may keep the 24h TTL. A block, timeout, upstream error, or extractor error must not be stored under the success key. A separate short lock (proposal: 10 minutes) can sit in front of a repeated block so Gyges' poll does not launch Chromium every minute.
7. **Parser.** A Recruitee id whose host is not `*.recruitee.com` is a parser miss and falls through to AI (or to `blocked` if the classifier already matched). It does not throw out of the orchestrator.
8. **Browser.** If `newContext` fails because the shared browser is disconnected, drop the reference and launch once more. A second failure is `internal` / `browser_unavailable`.
9. **Model id.** Read `ANTHROPIC_MODEL` (default discussed in the open questions). The hardcoded retired id should be replaced in that implementation, otherwise every classified-ok page still ends as `extractor_failed` and the monitor stays red for a reason that is not SiteGround.

### Option C — Stealth, proxy, and captcha solving

A patched browser fingerprint, residential proxies, or a captcha vendor, plus retries around them.

- Puts the scraper in a race with SiteGround, and the monitor still cannot tell a block from a bug when the vendor has an outage.
- Higher cost and a policy question this incident did not ask.
- Rejected as the response to #3097.

## Recommendation

Ship **option B**. Option A is the first commit inside that work (logging and the error type), not a substitute: Gyges cannot distinguish "blocked" from "bug" while every failure is HTTP 500 with one string.

Do this in the implementation PR, not in this one:

1. Logger on, route logs the `err` object, AI validation errors stop coming out as HTTP 400.
2. Confirm on one domain (`veluwsebron.nl` or `bas-hr.nl`) whether the logged name is an Anthropic model error, a Recruitee throw, or a challenge page that reached `extract`. That single log line ranks H1 against H2 with production evidence.
3. Classifier, fail-fast, cache split, one retry, Recruitee guard, browser relaunch, `ANTHROPIC_MODEL`.

Gyges keeps using HTTP 500 as "scraper bug" only if its check is updated to allow 422 `blocked`. Until that Gyges change, a correct 422 can still paint the monitor red. The contract is still worth shipping: the body is what the Gyges change will branch on, and 500 stops meaning "anything".

## Detection signals

Pure function, easy to unit test: `(status, headers, html) → ok | challenge | not_found | upstream_error | transport_error`.

**Challenge (any one marker).** Case-insensitive, prefer `<title>`, script `src`, and known ids over a single word in a long article.

| Vendor | Signals |
| --- | --- |
| SiteGround | `sgcaptcha`, `sg-captcha`, `sg-security`; `set-cookie` containing `sgcaptcha`; HTTP **202** with `content-type: text/html` and either a marker or a thin body |
| Cloudflare | `cf-mitigated`, `cf-challenge`, `cf-turnstile`, `challenge-platform`, title `Just a moment` |
| DataDome | `x-datadome`, `datadome`, `dd-cid` |
| PerimeterX | `_pxhd`, `px-captcha`, `perimeterx` |
| Generic | HTTP 401 / 403 / 429 on an HTML interstitial whose visible text is short and whose title or scripts match `captcha`, `are you a robot`, `bot detected`, `access denied` |

**Guards against false blocks.**

- HTTP 200, long visible text, and career indicators: `ok`, including when an application form embeds reCAPTCHA.
- HTTP 404 / soft empty on a guessed path: `not_found`. Discovery tries the next candidate.
- HTTP 202 + `text/html` + substantial career text and **no** vendor marker: treat as page content. A bare 202 with a thin body on the apex host is a challenge.
- Marker wins over `looksLikeCareerPage`. An echoed `/vacatures` inside a challenge must not open the AI extractor.
- Sitemap bodies go through the same classifier. A challenge is not scanned for `<loc>`.

**Upstream:** target HTTP 500 / 502 / 503 / 504 after the one retry. **Transport:** abort, DNS, TLS, connection reset, Playwright `net::ERR_*` of that family.

## Proposed error contract

Success stays `200` and the current `ScrapeResponse`. No new required fields.

Errors:

```json
{
  "error": "Target blocked the scrape",
  "code": "blocked",
  "reason": "bot_challenge",
  "retryable": false,
  "domain": "bas-hr.nl",
  "target": {
    "url": "https://bas-hr.nl/vacatures",
    "httpStatus": 202,
    "vendor": "siteground"
  }
}
```

`error` is a short stable English sentence for humans and for clients that only read that string today. `code` is the machine branch. `reason` is optional detail. `target` is omitted when the failure is ours (model, bug) and there is no URL to show. Never include HTML, stacks, or headers that might carry cookies.

| `code` | HTTP | `retryable` | When | Gyges |
| --- | --- | --- | --- | --- |
| `invalid_request` | 400 | false | Request Zod only | Caller bug |
| `unauthorized` | 401 | false | Bad or missing bearer | Config |
| `blocked` | 422 | false | Classified challenge, or 403/429 interstitial | Per domain. Not a scraper outage |
| `upstream_unavailable` | 502 | true | Target 5xx or transport, after one retry | Yellow |
| `timeout` | 504 | true | Budget exceeded (proposal 25s) or leftover Playwright timeout | Yellow |
| `extractor_failed` | 502 | false for `model_unavailable` and `extractor_parse`; true for provider 429 / 529 / connection reset | Anthropic or parser after the Recruitee guard | Red when `reason` is `model_unavailable` |
| `internal` | 500 | false | Anything else, including `browser_unavailable` after the one relaunch | Red |

`reason` values: `bot_challenge`, `http_forbidden`, `rate_limited`, `upstream_http`, `network`, `timeout`, `model_unavailable`, `extractor_parse`, `parser_failed`, `browser_unavailable`, `unexpected`.

`vendor`: `siteground` | `cloudflare` | `datadome` | `perimeterx` | `generic` | null.

Example, retired model, once logging and the contract exist:

```json
{
  "error": "Extractor failed",
  "code": "extractor_failed",
  "reason": "model_unavailable",
  "retryable": false,
  "domain": "veluwsebron.nl"
}
```

Example, genuine empty (unchanged success shape):

```json
{
  "domain": "example.nl",
  "hasVacancies": false,
  "vacancyCount": 0,
  "vacancies": [],
  "source": { "platform": null, "careerPageUrl": "", "method": "ai" },
  "cached": false,
  "scrapedAt": "2026-09-23T12:00:00.000Z"
}
```

That 200 is only for "we fetched the site and it has no career page". It is no longer the outcome of a challenge or a network failure.

## Retry and fail-fast

| Situation | Action |
| --- | --- |
| `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, undici socket errors, target 502/503/504 | One HTTP retry, same URL |
| Playwright `net::ERR_CONNECTION_RESET`, `ERR_NETWORK_CHANGED`, `ERR_ABORTED` on a page not already classified as a challenge | One retry |
| HTTP challenge markers | One Playwright attempt per host, 10s, `domcontentloaded`. Second challenge: stop that host |
| 401, 403, 404, 429, classified challenge | No retry |
| Anthropic HTTP 429 or 529 | One retry |
| Anthropic model 404 / `not_found_error` | No retry. `extractor_failed` / `model_unavailable` |
| AI JSON or Zod failure | No retry. `extractor_failed` / `extractor_parse` |
| Shared browser disconnected | One relaunch per process, then `browser_unavailable` |
| Whole candidate list | No second walk |

Request budget proposal: **25 seconds** for `POST /api/scrape`, enforced in the orchestrator, returning `timeout` rather than running 22 URLs × 45s. The 6.5s of fixed Playwright waits stay for a page that classified as `ok` and needs JavaScript; they are skipped on a challenge document.

Fail fast when the apex and `www` host are challenged. Keep walking when only a guessed subdomain fails.

## Cache

| Outcome | Success key (24h) | Other |
| --- | --- | --- |
| Vacancies, or a real "no career page" | Store, as today | |
| `blocked` | Do not store | Optional lock, 10 min, separate key |
| `timeout`, `upstream_unavailable`, `extractor_failed`, `internal` | Do not store | Next poll tries again, unless the block lock applies |
| Cache hit | Return immediately | A block that starts after a successful scrape stays invisible until TTL. Accepted. |

Rollout: domains already cached as empty or as bad AI output keep that JSON until TTL (up to 24h) or until someone deletes those keys. A flush of the whole Redis DB is a separate ops decision; the implementation should not do it by default.

`CacheService` should attach an `error` listener when `REDIS_URL` is set, and keep the current fallback. That removes the crash path. It does not explain today's JSON.

## Edge cases

- **Bot UA versus browser UA.** The one Playwright attempt exists so a site that only dislikes `VacancyBot` can still be scraped. A site that challenges both (the SiteGround + datacenter-IP case) returns 422 without walking `/jobs`, `/careers`, and the rest.
- **Legitimate HTTP 202.** Kept when the body is real career HTML and has no vendor marker.
- **reCAPTCHA on an application form.** Status 200 and a long vacancy text stay `ok`.
- **Echoed URL inside the challenge.** Classifier runs before `looksLikeCareerPage`.
- **`werkenbij{name}.nl` NXDOMAIN or challenge.** Skip. The domain fails only when its own host is blocked or nothing reachable remains.
- **All candidates 404, homepage readable, no career link.** HTTP 200 empty, cached.
- **All candidates transport errors.** `timeout` or `upstream_unavailable`, not a cached empty success.
- **Platform widget string in a footer.** Recruitee host check. Other platforms already fall through.
- **`detailLimit > 0`.** Overview block fails the request. A single detail URL that is blocked skips that vacancy and returns 200 for the rest (today's catch), and should log `blocked` at warn. Confirm Gyges sends the default `0` (open question). Those detail catches cannot be the 500 in this incident when `detailLimit` is 0, because the loop does not run.
- **AI `ZodError`.** Mapped to `extractor_failed`, never to `invalid_request`.
- **Success cache during a new block.** Stays 200 until expiry.
- **Empty result already cached before the fix.** Served for the rest of the TTL. Document a key prefix (`vacancy:` + hash) so ops can delete specific domains without a flush.
- **Parallel batch of three contexts on one browser.** A dead browser fails the batch; the relaunch rule covers it. Do not start twenty more launches.
- **Sitemap challenge.** Not parsed as URL list.
- **Gyges timeout below ours.** Unknown. The 25s budget is a proposal so we return JSON instead of a reset. If Gyges gives up at 15s, lower the budget to match (open question).
- **Other products.** ChatSync uses the same `ScraperService` and the same silent `catch`. Out of scope except the question to Remco.

## Test plan

For the implementation PR. This design PR adds no tests.

Unit, no network, fixtures as strings:

1. Classifier: SiteGround-like 202 HTML with `sgcaptcha`; Cloudflare `Just a moment`; DataDome header; HTTP 200 vacancy page that contains an application reCAPTCHA; HTTP 200 page whose only career word is inside an echoed URL on a thin challenge; HTTP 404; HTTP 503.
2. Discovery: apex 202 challenge returns `ScrapeFailure(blocked)` and does not call the extractor. Guessed subdomain challenge is skipped. All-404 homepage without career links returns the empty success object. Sitemap body that is a challenge yields no `<loc>` candidates.
3. Route: `ScrapeFailure` maps to the status table; request `ZodError` → 400 `invalid_request`; extractor `ZodError` wrapped as `extractor_failed` → 502; bare `Error` → 500 `internal` and a log call. Assert the log sink received `err.message` and the response body has no stack.
4. Recruitee: HTML containing `recruitee` and URL `https://bas-hr.nl/vacatures` does not throw; it falls through.
5. Retry counter: connection reset retries once; `blocked` and model 404 retry zero times.
6. Cache: `blocked` does not write the success key; empty success still writes it.
7. Playwright policy: HTTP challenge invokes the browser double-check once; a second challenge does not call `goto` again. Use a fake `ScraperService`.
8. Existing `src/__tests__/integration.test.ts` stays on the success and 400/401 paths. Extend it with one injected `ScrapeFailure`.

Manual, after deploy, by someone with Forge access:

- Daemon log contains `code`, `reason`, and `err.message` for one failing domain.
- `bas-hr.nl` returns 422 `blocked` with `vendor: siteground` when the public page is still a 202 captcha, and the daemon log does not show an Anthropic call for that request.
- A domain that still serves a normal career page returns 200 with vacancies (or a logged `model_unavailable` if the model id was not changed yet).
- Second request inside the block lock does not launch Chromium (log line, not a new browser stderr burst).
- `GET /health` stays 200.

## Open questions for Remco

1. Was the Gyges check green this morning on these same domains, or did 13:45 start the check / follow a deploy / follow a cache expiry? A green uncached AI scrape this morning means H1's model id was still being served.
2. Should Gyges treat HTTP 422 `code=blocked` as per-domain and non-red, and keep red for `internal` plus `extractor_failed` with `model_unavailable`? Who changes the Gyges check?
3. Is the one short Playwright attempt after a bot-UA challenge the right policy, or should a SiteGround 202 fail immediately with no browser?
4. Is a 10-minute block lock acceptable so a one-minute Gyges poll does not relaunch Chromium?
5. May transport and challenge failures stop occupying the 24h "no vacancies" cache? (Recommendation: yes.)
6. May the error body include `vendor` and target HTTP status?
7. Does Gyges send `detailLimit`, or only `{ "domain" }`?
8. What is Gyges' client timeout? The proposed server budget is 25s.
9. Which model id replaces `claude-3-5-haiku-20241022`? The provider's named replacement is `claude-haiku-4-5-20251001`, Active and "not sooner than 2026-10-15". Prefer `ANTHROPIC_MODEL` on Forge so the next retirement is a config change.
10. Same contract on `/api/chatsync`, `/api/google-ads`, `/api/linkedin-ads`, and `/api/customer-reviews` now, or only `/api/scrape`?
11. After the fix, should ops delete the `vacancy:` keys for `bas-hr.nl`, `veluwsebron.nl`, `odachterhoek.nl`, and `improvement-it.nl`, in case a 200 empty result was cached earlier in the day?

## Implementation sequence

For a later PR. Not started here.

1. Logger and `ScrapeFailure` mapping, including the AI `ZodError` split. Deploy and read one real exception from `daemon-*.log`.
2. Set `ANTHROPIC_MODEL` off the retired id once that log agrees (or immediately, if Remco answers question 9 first).
3. Classifier, Playwright double-check, cache split, retry table, Recruitee host guard, browser relaunch, request budget.
4. Gyges monitor reads `code`.
