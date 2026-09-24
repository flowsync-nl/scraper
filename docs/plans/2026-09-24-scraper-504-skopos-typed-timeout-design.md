# Design: typed timeout voor `skopos.nl` (issue #3108)

Datum: 2026-09-24. Design-only. Geen applicatiecode in deze PR.

Vervolg op het typed-errorcontract van #3097 (`94b4f04`, `fix(scrape): typed errors for captcha blocks and retired model`). Er is geen apart designbestand voor #3097 onder `docs/plans`; het contract staat in code en in `public/docs.html`.

## Doel

`POST /api/scrape` met `domain=skopos.nl` moet, als het budget op is, **betrouwbaar** eindigen op de bestaande timeout-response: HTTP-status en JSON-body uit `ScrapeFailure`, vóór de reverse proxy / Cloudflare de verbinding doodt.

Gyges (monitor resource 26, `https://monitor.flowsync.nl/resources/26`) ziet nu HTTP 504 na ~25,16s met platte tekst `error code: 504`. Dat is een gateway-pagina, geen body uit `ScrapeFailure.toBody()`.

Deploy: `https://scraper-mtx0os3l.on-forge.com`.

## Non-goals

- Gyges aanpassen (soft-504, status negeren, andere drempel). Ander systeem; alleen als open vraag aan Remco.
- Vacatures van skopos.nl alsnog succesvol scrapen. Als de pipeline binnen het budget een career page vindt, blijft het succespad zoals het is. Deze change belooft alleen een echte timeout-fout in plaats van een anonieme gateway-504.
- ChatSync, Google Ads, LinkedIn Ads, customer reviews.
- Nieuwe error-`code`. `timeout` bestaat al.
- Timeout-responses cachen. Dat mag niet, en doet de code nu ook niet.

## Huidig gedrag

### Contract (#3097), al live

`ScrapeFailure.httpStatus()` mapt `code: 'timeout'` op **504**. `toBody()` levert JSON, geen HTML, geen stack.

```129:145:src/services/scrape-failure.ts
  httpStatus(): number {
    switch (this.code) {
      // ...
      case 'timeout':
        return 504;
```

Publieke tekst: `timeout: 'Scrape timed out'`. `retryable` is `true` voor `timeout`. Route `src/routes/scrape.ts` vangt de fout en doet `reply.code(mapped.status).send(mapped.body)`. Test: `src/routes/__tests__/scrape-errors.test.ts` (`slow.nl` → 504, `code=timeout`). Docs: `public/docs.html` (“Budget van 25s of een fetch-timeout”).

Voorbeeld dat de client zou moeten zien (dit is het contract; skopos levert het nu niet af):

```json
{
  "error": "Scrape timed out",
  "code": "timeout",
  "reason": "timeout",
  "retryable": true,
  "domain": "skopos.nl"
}
```

`stage` zit in de log via `scrapeLogFields`, niet in de publieke body. Dat blijft zo.

### Budget is een checkpoint, geen harde klok

`SCRAPE_BUDGET_MS = 25_000` in `src/services/orchestrator.ts`. `Orchestrator.scrape` zet `deadline = Date.now() + budgetMs`. `assertBudget` gooit `ScrapeFailure({ code: 'timeout', stage: 'budget' })` alleen **tussen** stappen: vóór discovery, vóór een department-URL, vóór een detail-URL.

Fastify in `src/index.ts` zet geen `requestTimeout`, `connectionTimeout` of `keepAliveTimeout`. Node houdt de request open tot de handler terug is. Er is geen timer die de handler afbreekt op de deadline.

### Wat de deadline wél begrenst

- `GuardedFetcher.budgetTimeout` (`src/services/guarded-fetcher.ts`): HTTP-cap 10s, Playwright-probe 10s, Playwright-full cap **45s**, alle drie `min(cap, remaining)`.
- `DiscoveryService.remainingTimeout` voor sitemap-`fetch`: cap 10s.
- `DiscoveryService.finish`: als er geen bruikbare pagina is en er wél een fetch-timeout was, `code: 'timeout'`, `stage: 'discovery'`.

### Wat door de deadline heen loopt

1. **Playwright ná `page.goto`.** In `ScraperService.fetchWithPlaywright` geldt `timeout` alleen voor `page.goto`. Daarna, in mode `full` en zonder challenge: `waitForTimeout(3000)`, `dismissCookieConsent` (tot 19 selectors × 500ms visibility, plus 1000ms na een klik), scroll 3 × 500ms, `waitForTimeout(2000)`. Dat is ruwweg 6,5–16s **bovenop** de goto, buiten `budgetTimeout`.
2. **Claude.** `AIExtractor.complete` (`src/services/ai-extractor.ts`) roept `messages.create` aan zonder `timeout` en zonder `AbortSignal`. De SDK wacht standaard minuten. `assertBudget` draait pas ná die call. Eén modelcall die start op t=20s kan de gateway voorbij de 25s trekken. Zelfde gat voor `extractDetails` en voor `parseWithPlatform` (Recruitee; skopos is dat niet).
3. **Discovery-lus.** `getCareerPageCandidates` (`src/utils/url.ts`) levert 6 subdomeinen en daarna 17 paden, sequentieel, ná de sitemap. `assertBudget` zit tussen kandidaten, niet ín een lopende full-render of modelcall.

### Cache

- Succes en een echte lege career page (`emptyResponse`) gaan 24 uur in `vacancy:…` (`CacheService`, `orchestrator.scrapeUncached`).
- Een `ScrapeFailure` wordt niet in die key gezet. Alleen `code: 'blocked'` krijgt een lock `vacancy-block:…` (10 min). Test: `does not cache a timeout` in `src/services/__tests__/discovery-blocked.test.ts`.
- Risico om te bewaken: een afgebroken discovery mag niet als `null` uit `findCareerPage` komen. `null` na `sawOk` wordt een gecachte lege success (`finish` → `emptyResponse`). Een timeout moet blijven throwen.

### Waarom skopos.nl de 25s vol maakt

Extern is de site snel (meting 2026-09-24, vanaf deze omgeving):

| URL | Resultaat | Tijd |
| --- | --- | --- |
| `https://skopos.nl` | 301 → `https://www.skopos.nl/` | ~1,8s |
| `https://www.skopos.nl/` | 200, HTML met zichtbare tekst | ~3,5s inclusief redirect-keten |
| `https://werkenbijskopos.nl`, `careers.` / `jobs.skopos.nl` | DNS faalt direct | <10ms |
| `https://skopos.nl/vacatures` | 301 → www, daarna 404 | ~1,7s |
| `https://www.skopos.nl/werken-bij/` | 200, titel “Werken bij - Skopos” | ~1,8s |
| `https://skopos.nl/sitemap.xml` | volgt naar `sitemap_index.xml` (page/post/team), geen career-URL in de loc | ~2s |

`fetchSitemapUrls` filtert op `CAREER_KEYWORDS` in de URL. De index-locs (`page-sitemap.xml`, `post-sitemap.xml`, `ons_team-sitemap.xml`) vallen af. Discovery valt terug op kandidaten.

Volgorde tot de echte pagina: sitemap (~2s), 6 dode subdomeinen (snel), dan `/vacatures`, `/careers`, `/jobs` (elk een GET die de 301 volgt, ~2s, geen career-hit), dan `/werken-bij`. `hasCareerSignals` kent `werken bij`, dus die pagina kán een hit zijn zodra hij aan de beurt is. Geschatte discovery: orde 10s, niet “site down”.

Daarna gaat `AIExtractor.extract` het HTML in, zonder deadline. Department-loop (tot 5 extra fetches + extracts) start alleen als er minder dan 5 vacatures uitkomen, en checkt het budget alleen tússen die URLs. De hang van ~25,16s past bij: pipeline nog bezig (modelcall of een Playwright-staart) terwijl een proxy met een timeout rond de 25s de socket sluit. Cloudflare’s eigen 100s-venster (524) verklaart 25,16s niet. De platte body `error code: 504` is het edge/gateway-antwoord, niet `{"code":"timeout"}`.

`bas-hr.nl` uit #3097 is hier geen tegenvoorbeeld: die eindigt op 422 `blocked` zodra de challenge-HTML binnen is, ruim binnen het budget. skopos komt voorbij HTTP en sterft in het stuk zonder klok.

## Opties

### A — App-budget onder de proxy-timeout, en de JSON altijd flushen

`SCRAPE_BUDGET_MS` van 25s naar bijvoorbeeld 18s. Zelfde `ScrapeFailure`, zelfde 504, zelfde route. De proxy (aangenomen ~25s) heeft dan een paar seconden speling.

Alleen de constante verlagen is niet genoeg. Een Claude-call of de Playwright-staart die op t=17s start, loopt alsnog voorbij 25s. A werkt alleen samen met een echte abort (C).

### B — Proxy / Cloudflare-timeout verhogen

Nginx op Forge (`proxy_read_timeout`) en/of het CF-venster boven de slechtste app-duur zetten.

Lost het niet op zolang `messages.create` geen plafond heeft: de langste call is minuten, niet 25s. De proxy verliest dan alsnog, alleen later, nog steeds met `error code: 504`. Bovendien is dit een serverwijziging buiten deze repo, en elke andere trage route op dezelfde site gaat mee. Niet de kleinste fix.

### C — Vroege abort midden in de pipeline

Eén deadline die lopend werk afbreekt, niet alleen de volgende checkpoint:

- HTTP en sitemap: abort blijft `budgetTimeout` / `AbortSignal.timeout` (bestaat).
- Playwright: het `timeout`-argument ook laten gelden voor de waits ná goto, of die waits overslaan als `remaining` onder een drempel zit. Geen tweede, langere klok.
- `AIExtractor.complete`: `timeout` of `signal` op `messages.create`, afgeleid van dezelfde deadline. Bij abort: bestaande `ScrapeFailure` `code: 'timeout'`, `stage: 'extract'` (of `'budget'` als de klok van de orchestrator komt).
- De route of orchestrator houdt één `setTimeout` / `AbortSignal.timeout(budgetMs)` dat de promise reject met die failure, zodat een vergeten awaitsite niet alsnog de proxy haalt.

Geen nieuw responseformaat. Geen cache-write op dit pad.

### D — A + C (aanbevolen)

1. Harde abort op het bestaande budget-object, inclusief Claude en de Playwright-staart (C).
2. `SCRAPE_BUDGET_MS` naar **18_000**, zodat de typed 504 de deur uit is vóór een proxy rond 25s (A). Constante blijft de enige plek; docs-zin “Budget van 25s” in `public/docs.html` mee naar 18s als de implementatie landt.
3. Proxy (B) niet wijzigen in deze change. Als Remco meet dat de edge korter is dan 18s, eerst dat getal bevestigen (open vraag), niet gokken.

### Trade-offs van D

- Sommige domeinen die nu nét binnen 25s een antwoord hebben, worden een retryable timeout. Dat is het punt: liever een echte `code=timeout` dan een gateway-504 of een gecachte lege success.
- skopos.nl krijgt hier géén garantie op vacatures. `/werken-bij/` is een aannemelijke hit; of Haiku binnen 18s klaar is, is een aparte meting. Department-fetches die niet meer in het budget passen stoppen via `assertBudget` / de abort, zoals nu bedoeld is.
- HTTP-status blijft 504. Gyges kleurt 504 rood zolang Gyges alleen naar status kijkt. Deze change maakt de body en de app-log bruikbaar (`stage`, `code`, `domain`). Groen maken is het non-goal, tenzij Remco dat apart wil.

Niet doen: 504 vervangen door 408. Het contract en de docs leggen timeout op 504 vast; een tweede status splitst #3097.

## API / foutcontract

Geen nieuw veld, geen nieuwe `code`. Blijft:

| | |
| --- | --- |
| Status | 504 |
| `error` | `Scrape timed out` |
| `code` | `timeout` |
| `reason` | `timeout` |
| `retryable` | `true` |
| `domain` | request-domein |
| `target` | alleen als er een URL/status is; voor een budget-abort meestal afwezig |

Log (wel, niet in de body): `stage` (`budget`, `discovery` of `extract`), `domain`, `err.message` via `safeErrorMessage`. Geen HTML, geen sleutels.

Cache: geen `vacancy:`-write, geen `vacancy-block:`-write. Een volgende call mag opnieuw proberen.

## Edge cases

- **Abort na een OK-pagina die geen career page is.** Throw `ScrapeFailure`. Niet `finish()` → `null` → `emptyResponse` → 24h cache.
- **Abort tijdens `messages.create`.** Geen halve JSON als succes cachen. De throw gebeurt vóór `cache.set` van het succespad; dat pad zet de cache pas na de hele extractie.
- **Block-lock.** Een timeout schrijft geen lock. Een eerder `blocked` op hetzelfde domein blijft het korte lock-pad (`stage: 'cache'`) en start geen browser.
- **In-flight fetch die zelf al `timeout` classificeert.** `DiscoveryService.finish` gooit al `code: 'timeout'` als er alleen timeouts waren. De harde klok mag die failure niet vervangen door `internal`.
- **Playwright-challenge.** Blijft 422 `blocked` als de challenge vóór de deadline binnen is (het #3097-pad). Alleen een challenge-probe die de deadline overschrijdt wordt `timeout`.
- **Client hangt al op.** Als de proxy toch wint, logt de app de `ScrapeFailure` als de abort alsnog vuurt, ook al is de socket weg. Geen tweede response.
- **Detail-loop en department-loop.** Bestaande `rethrowFatal` laat `timeout` door. De abort moet daar niet worden geslikt door de `catch` die alleen logt (`Failed to scrape department page`).
- **Overige routes** op dezelfde poort. Een server-brede Fastify-`requestTimeout` van 18s zou chatsync en reviews meenemen. De klok hoort op het scrape-budget, niet op het hele proces. Optie B (nginx) heeft dat bezwaar wel; daarom niet nu.

## Testplan (implementatie, niet deze PR)

- Unit: orchestrator met een `extract` die nooit resolved en `budgetMs` klein → reject `code: 'timeout'`, `cache.get(keyFor(domain))` is `null`, geen block-lock.
- Unit: `fetchWithPlaywright` full-mode met een krappe timeout doet de cookie/scroll-staart niet als de goto-timeout al op is (fake page).
- Unit: `AIExtractor.complete` met een klant die de signal respecteert → `ScrapeFailure` timeout, geen `extractor_failed`.
- Bestaande route-test `slow.nl` blijft 504 + JSON. Nieuwe test: handler die trager is dan het budget levert nog steeds `content-type` JSON en body `code=timeout`, niet platte tekst.
- Regressie #3097: `blocked` blijft 422 en schrijft wel de lock; lege echte career page mag nog cachen.
- Handmatig na deploy, tegen `scraper-mtx0os3l.on-forge.com`: `POST /api/scrape` `{"domain":"skopos.nl"}` eindigt onder de gemeten proxy-tijd, body parseert als JSON met `code` gelijk aan `timeout` of — als de site binnen het kortere budget klaar is — een normale `ScrapeResponse`. In beide gevallen geen body `error code: 504`. App-log bevat `domain=skopos.nl` en `code`.

## Aanbeveling

**D.** Kleinste wijziging die Gyges een typed failure kan laten zien en de log de echte reden geeft: dezelfde `ScrapeFailure`-timeout als #3097, hard afbreken inclusief Claude en de Playwright-staart, en het app-budget naar 18s zodat het antwoord vóór een ~25s-gateway vertrekt. Proxy niet oprekken. Gyges niet aanraken. Status 504 laten staan.

## Open vragen voor Remco

1. Welke timeout staat er op de keten vóór Node (Forge nginx `proxy_read_timeout`, eventueel Cloudflare) voor `scraper-mtx0os3l.on-forge.com`? De 25,16s lijkt op het app-budget, niet op CF’s 100s. Het 18s-voorstel gaat uit van een proxy rond 25s. Klopt dat getal?
2. App-budget: 18s met harde abort, of een ander aantal? Langer dan de proxy mag het niet worden.
3. HTTP-status: 504 met typed JSON houden (voorstel, gelijk aan #3097), of wil je 408? Gyges blijft rood op elke 504 zolang alleen de status telt.
4. Is “typed failure + logregel” genoeg voor #3108, of moet Gyges daarna alsnog zacht op deze 504 (ander repo, nu non-goal)?
5. Moet een geslaagde scrape van `www.skopos.nl/werken-bij/` in dezelfde change, of is een eerlijke timeout genoeg tot er een aparte discovery-wijziging is?
