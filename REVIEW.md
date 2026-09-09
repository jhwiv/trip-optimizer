# Peer review — jhwiv/trip-optimizer (RouteSmith)

**Scope:** code-level QA of this checkout (`master` @ `6e8814c`). No drive-by refactors. Findings below are cited to files/lines that exist in this tree.

**Date:** 2026-09-09

---

## 0. Brand / domain mapping — this is not aripshitadventure.com

**This repository is RouteSmith (the planner), not A Ripshit Adventure (the published trip site).**

| | This repo (`jhwiv/trip-optimizer`) | A Ripshit Adventure |
|---|---|---|
| GitHub | https://github.com/jhwiv/trip-optimizer | https://github.com/jhwiv/aripshitadventure |
| Product | Interactive itinerary **builder** (wizard + `/find`) | Static branded **trip guide PWA** |
| Canonical domain | `https://www.routesmith.ai` (alias `trip-optimizer-6og.pages.dev`) | `https://aripshitadventure.com` (per the task; the sibling repo is the source) |
| Brand strings | `RouteSmith` / `Route Smith` / `Trip Optimizer` | `A Ripshit Adventure` — **zero matches** in this tree |
| Deploy | Cloudflare Pages from **`master`** | Cloudflare Pages, static, no build step |
| Runtime | React 18 + Vite + Pages Functions (`functions/api/*`) | Plain `index.html` + `app.js` + `style.css` |

Evidence in this repo:

- Production branch and domain: `CLAUDE.md` lines 9–14 (`master` deploys to routesmith.ai).
- Canonical URL: `docs/wiki/entities/repo-and-deploy.md` lines 24–27.
- PWA name: `public/manifest.webmanifest` (`"name": "RouteSmith"`).
- Page title: `index.html` line 32 (`<title>Route Smith</title>`).
- Grep for `aripshit` / `ripshit` / `aripshitadventure.com`: **no hits**.

How the two products relate: `scripts/publish-trip-site.mjs` (lines 1–37, 90) turns a RouteSmith plan JSON / “Export as web app” HTML into a standalone Cloudflare static site. The sibling repo’s own README states its content “originates from the verified itinerary export (`data/trip-data.json` — the same structured JSON embedded in the ‘Export as Web App’ download from the trip-planning app…)”. So **aripshitadventure.com is a published descendant of a RouteSmith build**, not a rebrand of this app.

If the goal is to QA the London→Normandy→Porto branded site itself, review **`jhwiv/aripshitadventure`**, not this tree. The rest of this document reviews RouteSmith.

---

## 1. Program / architecture problems

### 1.1 `src/App.jsx` is the entire product (18,352 lines)

Wizard, FindView, ReviewPanel, quality layer, PDF/share UI, session recovery, chunked builds, and most cards live in one file. Module-level helpers (`applyQualityLayer` at line 2828, `FindView` at 12109, `TripOptimizer` at 14008) are mixed with UI.

Consequences that show up as real bugs in this codebase’s own history (`CLAUDE.md` KNOWN FAILURE MODES):

- `applyQualityLayer` is **not exported**, so tests cannot import it. `tests/test_apply_quality_layer_structural.mjs` lines 1–12 copy a “mirror” of the glue and already cite **stale line numbers** (`App.jsx:3404-3472` / `:3687-3712`). The real function starts at 2828; the structural tail has moved.
- Two similarly named parameters (`input` vs `inputs`) silently disabled marquee coverage and the restaurant-closure gate (documented; code now double-reads both shapes). The hazard remains for every new line in that function.
- Wiki architecture doc is stale: `docs/wiki/concepts/architecture.md` line 13 still says `IntroductionAutoGenerator` is “at ~line 6088”; it is at **8215**.

This is not “big file = bad.” It is the reason fixtures/tests drift from the real schema and why UI wiring (e.g. `HotelCard` `flags`) can pass unit tests while the screen stays dark.

### 1.2 Client-only “auth” does not protect the API

`src/loginGate.js` lines 1–4 state the design explicitly: household words in the client bundle; **`/api/*` is not covered**. `src/main.jsx` lines 20–25 wrap only the React tree. Anyone who can `POST` the origin can spend Anthropic / Places / TomTom / Tripadvisor quota.

Accepted words are in source: `GATE_WORDS = ["travel", "meg"]` (`loginGate.js` lines 15–16). They ship in the public JS bundle. This is a courtesy lock, not a gate.

### 1.3 Open LLM / paid-API proxy (no auth, CORS `*`)

`functions/api/build.js` lines 67–141:

- No shared secret, cookie, or origin check.
- Request JSON is forwarded to Anthropic as `upstreamBody = { ...body, stream: true }` (line 157) with `env.ANTHROPIC_API_KEY` (lines 203–210). A caller can set `model`, `max_tokens`, `system`, tools — this is a **generic Anthropic proxy**, not a locked `submit_trip_plan` wrapper.
- Response headers include `Access-Control-Allow-Origin: *` (line 139), so **any website** can start a streaming build from a browser.

The same CORS `*` pattern is on find, menu, review-retrieve, places-verify, geocode, drive-time, tripadvisor, share (via default JSON helpers), verify-url, trip-map, destination-photo, inbound, etc.

`GET /api/build/:id` (`functions/api/build/[id].js` lines 8–43) is also unauthenticated. Job text in KV is the raw model output of a trip (names, hotels, flights). Knowing a 16-hex `jobId` is enough to read it. `debug=1` also returns `job:<id>:debug`.

**Dead sibling proxy:** `worker/index.js` lines 1–47 is an unused Workers script (no root `wrangler.toml` points at it) that POSTs arbitrary JSON to Anthropic with CORS `*`. Harmless while undeployed; dangerous if someone `wrangler deploy`s it.

### 1.4 Share pipeline: unauthenticated write of public HTML

`functions/api/share.js` lines 20–51:

- `POST` with `{ plan, inputs }` → `buildWebApp()` → KV `SHARES` with 90-day TTL.
- No auth, no size cap, no rate limit, 8-char hex id (`crypto.randomUUID()…slice(0, 8)`, line 37).
- Served at `GET /s/:id` (`functions/s/[id].js`) as `text/html` with `Cache-Control: public, max-age=86400` (lines 32–37).

`src/App.jsx` `handleShare` (4547–4568) posts the live plan. Combined with §1.3, anyone can publish itineraries (or crafted JSON) to this origin.

### 1.5 Session / form persistence is internally contradictory

Inside `TripOptimizer` (`App.jsx` 14015–14069 vs 14677–14690):

- Comment: form state is “INTENTIONALLY NOT PERSISTED across launches”; `LS_KEY` (`trip-optimizer-form-v4`) is wiped so launches start blank.
- The wipe (`localStorage.removeItem(LS_KEY)`, line 14069) runs in the **component body**, so it runs **on every render**, not at module init (the comment on 14067–14068 is wrong).
- A 400 ms debounced `useEffect` (14677–14690) writes the same `LS_KEY`. Nothing reads `LS_KEY` for hydration; form recovery uses `SESSION_KEY` (`trip-optimizer-session-v1`, 14076–14099).

Net: wasted writes, a wipe/write race, and a comment that does not match control flow. Crash recovery that actually works is `SESSION_KEY` (24 h TTL) plus `SAVED_TRIPS_KEY`. That split is sound; `LS_KEY` is leftover.

`findOnly` (14103–14108) is explicitly **not** persisted and does not change the URL. `/find` is a separate mount (`main.jsx` 13–18) with its own `FIND_LS_KEY`. Two find surfaces, two persistence models — see §2.3.

### 1.6 Race conditions that are real in this file

**PDF intro race — mitigated, not gone.** Known-issues doc (`docs/wiki/concepts/known-issues.md` §3) still lists it as active. The UI now gates PDF on `isPdfDownloadReady` (`App.jsx` 4674–4683, 8215+ `IntroductionAutoGenerator`). The wiki is stale relative to the code.

**Arrival-order gate is skipped for every UI PDF.** `PrintButton` always calls `saveItineraryAsPDF(…, { skipValidationForExistingPlans: true })` (line 4702). The helper’s own comment (4359–4363) says that flag is for **legacy** plans that predate a timezone fix. From the only user-facing call site, `ARRIVAL_ORDER` never blocks export — it `console.warn`s (4367–4371). Venue + continuity blocks still fire (4329–4353).

**Share copy has no rejection handler.** `handleCopy` (4571–4575) uses `navigator.clipboard.writeText(shareUrl).then(…)` with no `.catch()`. On HTTP, denied permission, or missing clipboard API this is an unhandled rejection; the button never shows failure.

**React `StrictMode`** (`main.jsx` line 21) double-invokes effects in development. Several headless generators (`IntroductionAutoGenerator`, `FlightNumberAutoResolver`) use once-per-signature guards; that is the right pattern, but it is easy to break when adding a new `useEffect` fetch in `App.jsx`.

### 1.7 Data model vs consumers

`DAY_ITEM_SCHEMA` has no `item.name` (see `CLAUDE.md` standing rule). That class of bug is historically this app’s worst. Remaining structural risk: any new renderer (PDF, web export, Find cards, Local Providers) that invents fields. `webExport.js` was already burned once (`CLAUDE.md` KNOWN FAILURE MODE header + #18). `buildWebApp` now passes real fields into `#trip-data` (643–669) — good — but `itemVenue()` / `formatTime()` still have to stay aligned with live `FlightCard`.

`applyQualityLayer` remains a single mega-function with `input`/`inputs` collision risk. Night math, continuity, cost text, loyalty flags, carrier rewrite, and meal-policy strip all mutate `out` in one pass. That is the correct *lifecycle* (one `useMemo` after every plan mutation — `CLAUDE.md` KNOWN FAILURE MODE #24) but a poor *module* boundary.

---

## 2. Logical inconsistencies

### 2.1 Product names disagree

| Surface | String |
|---|---|
| `index.html` title | `Route Smith` |
| `manifest.webmanifest` | `RouteSmith` |
| LoginGate coach (`LoginGate.jsx` 100) | `Put Route Smith on your Home Screen` |
| README live URL | `https://trip-optimizer-6og.pages.dev/` (not routesmith.ai) |
| Web-export footer (`webExport.js` 631) | `https://routesmith.app` — **not** `routesmith.ai` |
| PDF footer (`src/pdf/itineraryPdf.js` ~2191, `src/pdf/findPdf.js` 214) | `www.routesmith.ai` |
| LoginGate footer | Barrier Island Digital |
| `index.html` description | `Trip Optimizer — Powered by Barrier Island Digital` |

`routesmith.app` in the exported HTML is a real outbound link that does not match the documented canonical domain. Shared / published itineraries (including ones later turned into trip sites) carry that href.

### 2.2 Wizard steps vs “Find local info only”

On `/`, a switch (`App.jsx` 17564–17589, `role="switch"`) sets `findOnly` and **unmounts the wizard** in favor of `<FindView embedded />` (17620–17625). The URL stays `/`. `/find` is a different document (no `TripOptimizer` hooks).

Inconsistencies:

- Toggle copy: “Skip the wizard. Type a city…” (17548–17549). The `/find` route is the shareable version (`?q=` wins over localStorage — comment at 12002), but the toggle never navigates there, so a find session started from `/` is not a link you can send.
- `findOnly` resets on every launch (14106–14108). `/find` persists query + guidelines in `FIND_LS_KEY` (11849, 12264–12271).
- Embedded FindView hides its own header (12655–12657) and relies on the wizard brand bar + toggle as “back.” Standalone `/find` has a back-link to `/`. Two chrome models.

### 2.3 Dates / nights

The quality layer and `legNights.js` are the source of truth for night arithmetic; the Expert Review prompt is instructed not to recompute (`CLAUDE.md` KNOWN FAILURE MODE #10). Remaining product inconsistencies are generation-time (model writing `days[].city` as origin on transit days) plus any UI that still displays `plan.cities[].nights` before `applyQualityLayer` runs. The layer is `useMemo`’d from `rawData`, so the on-screen itinerary should be post-fix. PDF cover and cost-estimate *text* have dedicated checkers now.

Wizard night math still has the KNOWN FAILURE MODE #12 trap: `basics.cities[].nights` summing to 0 if someone writes blank multi-city rows. `multiStopHint` exists so extraction cannot do that; a user typing two cities and leaving nights blank still collapses `nightsNum`. That is user-visible if the multi-city form is used carelessly.

`BLANK.flights.homeAirport` is still `"EWR"` (`App.jsx` 14043) — intentional, test-locked in `tests/test_form_defaults.mjs`. Hotel brand / Hertz defaults were cleared (14024–14044). Callers who never fly from Newark still send EWR unless they clear it.

### 2.4 Share URL vs household lock

LoginGate never wraps `/s/:id` (that path is a Pages Function returning stored HTML, `public/_routes.json` includes `/s/*`). That is correct for sharing. Combined with unauthenticated `POST /api/share`, the share feature is a **public pastebin for itineraries** on the RouteSmith origin, while the planner UI pretends to be a “Private planner” (`LoginGate.jsx` 233).

Copy control: no error path (see 1.6). Expiry copy in the UI claims 90 days; KV TTL matches (`share.js` line 18). Cached HTML at the edge is 24 h (`functions/s/[id].js` line 36), so a delete/expiry can lag a day.

### 2.5 Find vs full build — verification and lodging

`/api/find` drops closed venues (`functions/api/find.js` lines 41–50). Client `findIsNotLodging` (`App.jsx` 11867–11874) will also drop a real restaurant whose **name** contains `inn` / `hotel` / `lodge` (comment acknowledges “Inn at Little Washington”). Full-build restaurant cards do not use that regex. Same `RestaurantCard` visual, different inclusion rules.

Find does not run `applyQualityLayer`, continuity checks, or meal policy. That is by design, but the landing toggle presents Find as a mode of the same app (“Find local info only”) rather than a different product surface.

### 2.6 PDF “cannot export” vs skip flag

Continuity / Places **block** flags still refuse PDF (4329–4353). Arrival-order **does not**, from the UI, because of `skipValidationForExistingPlans: true` on every click (4702). Labels in comments say “existing/legacy plan”; behavior is “all plans.”

---

## 3. UI / UX code smells that cause product bugs

### 3.1 iOS zoom — form fields are 16px; buttons are not the problem

`Inp` documents the 16px rule (`App.jsx` 9051–9057). LoginGate input is 16px (`LoginGate.jsx` 294). Share URL field is 16px with an explicit comment (4632–4634). This matches the CLAUDE.md third clipping hypothesis.

Remaining risk: any **new** `<input>` / `<textarea>` / `<select>` under 16px. Display text at 12–14px is fine (does not trigger iOS focus-zoom). The global `html, body { width: 100%; overflow-x: clip }` (`index.html` 112–129) is the vw/dvw mitigation; CLAUDE.md records the user’s device still clipped after that change — do not treat it as a confirmed fix.

### 3.2 Overflow / containing block

`#root { overflow-x: clip; position: relative }` (`index.html` 140–157). A comment records that `contain: paint` was removed because it made `#root` the containing block for `position: fixed` overlays (modals rendering below the fold). Current z-index stack:

| Layer | z-index | File |
|---|---|---|
| LoginGate | 10000 | `LoginGate.jsx` 193 |
| Meg homescreen coach | 10001 | `LoginGate.jsx` 61 |
| App intro overlay | 9999 | `App.jsx` 13192 |
| Build overlay dimmer | 9997–9998 | 13502, 13650 |
| Bottom sheets (menu, review) | 1000 | 2282, 7328, 8657 |
| Wizard extra overlay | 800–801 | 18084, 18096 |
| Find sticky section tabs | 10 | 12858 |
| City autocomplete | 50 (CSS) / 20 (Find) | `index.html` 201, `App.jsx` 12709 |

LoginGate sits above the intro (correct). Find sticky `zIndex: 10` can tuck under later wizard chrome if Find is ever composed differently. Bottom sheets at 1000 are below the build hero (9997+) — correct so a menu cannot cover an in-flight build.

### 3.3 Dead / weak controls

- Share **Copy** with no failure UI (4571–4575).
- Many `<button onClick=…>` omit `type="button"` (e.g. 1458, 4180–4181, 7087, 7271, 17819). Inside a `<form>` these become implicit submits. LoginGate’s Unlock is correctly `type="submit"`; the passphrase field is in a form. Wizard step buttons that sit outside forms are safer; any button later moved into the Details form will submit.
- `handleCopy` does not `type="button"` either (4642).

### 3.4 Accessibility

Positives: LoginGate has `role="dialog"`, `aria-modal`, labelled input, `aria-invalid`, `role="alert"` on error (`LoginGate.jsx` 185–188, 287–288, 336). Find toggle is `role="switch"` with `aria-checked` (17566–17568). Form inputs use 16px.

Gaps (not exhaustive):

- Icon-only `×` dismissers (e.g. saved-trip delete 4181 has `aria-label`; some others do). Welcome banner dismiss (17609–17615) has `aria-label="Dismiss"`.
- Bottom sheets often use overlay `onClick` to close without `role="dialog"` / focus trap / Escape (pattern at 2282, 7328). LoginGate and Meg coach are better.
- Contrast: `--color-text-tertiary` on `--color-background-primary` is below WCAG AA and **allow-listed** in `scripts/contrast-known-issues.json`. Tertiary is used as body-ish hint text in many places (e.g. `App.jsx` 9046).
- `index.html` lines 159–162 force `overflow-wrap: anywhere; word-break: break-word` on `p, span, label, h1–h4, div`, then restaurant names fight it with `.rc-name { word-break: normal }` (232–237). That global rule is why long names stacked one letter per line; the override is a patch, not a design.

### 3.5 Service worker vs login

SW registers for all production navigations (`main.jsx` 44–102). `/s/:id` is a Function, not the SPA, so the SW’s `networkFirst` HTML strategy should not intercept it if the request isn’t a same-origin navigation to `/`. Worth keeping in mind if SW `SHELL_URLS` ever grows.

SW update path (poll 60s, `SKIP_WAITING`, reload on `controllerchange`) can reload a tab **during an in-flight build**. Session snapshot + `ACTIVE_JOB_KEY` exist specifically for that; KNOWN FAILURE MODE #4 made resume opt-in. A mid-build SW reload still drops the live NDJSON stream and relies on KV poll/resume.

---

## 4. Security / secrets / PII

### 4.1 Secrets in repo

No hardcoded `sk-ant-` / `AIza` keys found. Secrets are `env.*` as documented. **Passphrases are not secrets** — they are in `loginGate.js`.

### 4.2 Unauthenticated expensive endpoints (cost + data)

| Endpoint | Risk |
|---|---|
| `POST /api/build` | Anthropic spend; arbitrary body |
| `GET /api/build/:id` | Read job output |
| `POST /api/find`, `/api/find-providers`, `/api/menu`, `/api/activity-details`, `/api/extract-trip`, `/api/extract-from-file`, `/api/introduction`, `/api/review-retrieve` | Anthropic / Perplexity |
| `POST /api/places-verify*`, `/api/place-autocomplete`, `/api/geocode-cities`, `GET /api/destination-photo`, `GET /api/trip-map` | Google Places / Static Maps billing |
| `POST /api/drive-time-verify` | TomTom |
| `POST /api/tripadvisor-verify` | Tripadvisor |
| `POST /api/share` | KV write + public HTML |

CORS `*` makes browser-origin abuse trivial, not just curl.

### 4.3 SSRF — `POST /api/verify-url`

`functions/api/verify-url.js` lines 33–45 accept any `http:`/`https:` URL, cap 60, then `fetch` from the Worker (61–95). No blocklist for `127.0.0.1`, RFC1918, link-local, metadata (`169.254.169.254`), or cloudflared internals. Cloudflare Workers have a different network than a home LAN, but this is still an **open URL fetcher** with CORS `*` (51–57, 146).

### 4.4 Inbound email PII

`functions/api/inbound/email.js`:

- Auth is `?secret=` compared to `SENDGRID_INBOUND_SECRET` (42–48). Query-string secrets land in access logs, CF analytics, and browser history if ever opened by a human.
- Stores `from`, `subject`, `rawText` (up to 20k), and LLM extraction including confirmation numbers (90–100) in `INBOUND_KV`.
- `GET /api/inbound/list?userId=` (`functions/api/inbound/list.js` 18–46) has **no secret**. If the binding is live, anyone can list `userId=default` (or `jeff`, etc.) and receive confirmation emails. CORS `*` via `experiences/_shared.js`.

If `INBOUND_KV` is unbound, list returns empty (25–26) — fail-safe. If it is bound in production, this is a P0 PII leak.

### 4.5 Stored XSS via share / web export

`webExport.js` `esc()` (16–23) covers `& < > "` for HTML body. The `#trip-data` block is:

```643:670:src/webExport.js
    `<script id="trip-data" type="application/json">`,
    JSON.stringify({ … }),
    `</script>`,
```

`JSON.stringify` does not escape `</script>`. A plan field containing `</script><script>…` breaks out of the JSON script tag. `/api/share` will **store and serve** that HTML (`functions/s/[id].js` 32–37). Because share is unauthenticated, this is stored XSS on `www.routesmith.ai/s/…`.

Standard fix: `JSON.stringify(obj).replace(/</g, "\\u003c")` (and/or replace U+2028/U+2029). Tiny change; not applied in this review-only pass.

`esc()` also does not encode `'` (fine while attributes use double quotes).

### 4.6 PII in the browser

Saved trips (`SAVED_TRIPS_KEY`, `App.jsx` 4021–4037) and session snapshots hold full itineraries (names, hotels, flight numbers, narrative with confirmation codes) in **localStorage**, no encryption. Expected for a client-only PWA; anyone with device access or an XSS (4.5) can read them.

### 4.7 Security headers

`public/_headers` sets cache policy only. No `Content-Security-Policy`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`, or `Permissions-Policy`. The app can be iframed; Google Fonts and `api.anthropic.com` (via Functions) are used. CSP would need a careful allowlist (inline styles are the entire UI).

---

## 5. Test gaps

CI (`/.github/workflows/ci.yml`): unit tests, ESLint, Vite build, contrast audit, hex-leak audit. **No Playwright / E2E in CI.** CLAUDE.md’s verification discipline is manual against a local dev server.

Strong coverage: date/nights/continuity, Places merge, flight strip/resolver helpers, loginGate pure helpers, webExport time/carrier, budget/cost checkers, form defaults.

Gaps:

| Area | What’s missing |
|---|---|
| `applyQualityLayer` | Not imported; hand-copied mirrors with drifting line comments (`tests/test_apply_quality_layer_structural.mjs` 1–12) |
| `POST /api/share`, `GET /s/:id` | No test file |
| `inbound/email.js`, `inbound/list.js` | No tests; list auth hole uncaught |
| `verify-url.js` SSRF / scheme checks | No tests beyond whatever find-url helpers exist |
| `worker/index.js` | Dead code, untested |
| XSS in `buildWebApp` JSON embed | `tests/test_web_export.mjs` does not assert `</script>` escaping |
| Arrival-order skip always true | No test that `PrintButton` / `saveItineraryAsPDF` call site blocks on `ARRIVAL_ORDER` |
| `LS_KEY` wipe-every-render | No test; comment vs behavior |
| LoginGate vs `/api/*` | `tests/test_login_gate.mjs` / `_ui` cover client words only |
| Find lodging regex false positives | Documented, not fixture-tested for “Inn at Little Washington” |
| Chunked-build prompt notes | Unit tests for *delivery* of instructions (`test_chunk_transition_notes.mjs`); model compliance cannot be tested here |
| Playwright QA script | Referenced as `scratchpad/qa_final.mjs` in CLAUDE.md; not in this repo’s `tests/` |

`docs/wiki/entities/repo-and-deploy.md` still says lint is a soft gate and lists only `ANTHROPIC_API_KEY` / `PERPLEXITY_API_KEY` / `JOBS`. CI lint is a hard gate (`ci.yml` 12–15). Env list omits `GOOGLE_PLACES_API_KEY`, `SHARES`, `PLACES`, `TOMTOM_API_KEY`, `TRIPADVISOR_API_KEY`, `INBOUND_KV`, `SENDGRID_INBOUND_SECRET`. Docs drift is a test/process gap: onboarding will mis-provision preview.

Contrast audit allow-lists tertiary-on-primary rather than failing (`scripts/contrast-known-issues.json`).

---

## 6. Prioritized fix list

### P0 — fix before treating this as a locked household app

1. **Do not leave `/api/build` as an open Anthropic proxy.** Restrict the body to the app’s tool/schema (strip caller-supplied `system` / `model` / extra tools), bind CORS to `https://www.routesmith.ai` (and pages.dev if needed), and add a gate the LoginGate cannot provide (signed cookie, Cloudflare Access, or at least a Pages secret header). Files: `functions/api/build.js` 67–210; same CORS on sibling Functions.
2. **Authenticate `GET /api/inbound/list` or disable the route until then.** Today `userId` is a query param (`functions/api/inbound/list.js` 18–22). Confirmation emails are PII.
3. **Escape `</script>` in `buildWebApp` JSON embed.** `src/webExport.js` 643–670. Unauthenticated `POST /api/share` makes this stored XSS. One-line replace is enough; add a test with a venue `text` of `</script><img src=x onerror=alert(1)>`.
4. **Cap and authenticate `POST /api/share`.** Size limit on `plan`; same origin/auth as build. `functions/api/share.js` 20–51.

### P1 — user-visible correctness or obvious abuse

5. **SSRF allowlist on `/api/verify-url`** (https only, no private/link-local/metadata hosts). `functions/api/verify-url.js` 33–95.
6. **Stop skipping arrival-order on every PDF.** Either pass `skipValidationForExistingPlans` only for saved trips older than a cutoff, or drop the skip and repair via `cascadeArrivalDayTimes`. `App.jsx` 4354–4371, 4702; `src/arrivalOrderCheck.js` 124–128.
7. **Fix `routesmith.app` → `https://www.routesmith.ai`** in `src/webExport.js` 631. Align `index.html` title / manifest / LoginGate (“Route Smith” vs “RouteSmith”).
8. **Remove or actually use `LS_KEY`.** Wipe-on-every-render + write-on-debounce is dead. `App.jsx` 14020–14069, 14677–14690.
9. **Share Copy `.catch` + `type="button"`.** `App.jsx` 4571–4643.
10. **Move `SENDGRID_INBOUND_SECRET` off the query string** (header / CF-Access). `functions/api/inbound/email.js` 42–48.
11. **Preview env keys** (already documented in `docs/wiki/concepts/known-issues.md` §1) — still blocks PR-level live verify.
12. **Export `applyQualityLayer` (or extract it)** so tests stop mirroring glue. Retire stale line comments in `tests/test_apply_quality_layer_structural.mjs`.

### P2 — hygiene, a11y, docs, test depth

13. Delete or clearly mark `worker/index.js` as not deployed.
14. Focus-trap + Escape on z-index 1000 bottom sheets; `type="button"` on wizard buttons that might sit in forms.
15. Contrast: stop using `--color-text-tertiary` for readable hint copy; shrink the allow-list.
16. Deep-link the find toggle to `/find?q=…` (or persist `findOnly`) so “skip the wizard” is shareable.
17. Document `SHARES` / `PLACES` / Maps / TomTom / Tripadvisor / inbound bindings in `docs/wiki/entities/repo-and-deploy.md` and README live URL.
18. Add tests: share handler, inbound list 401, webExport script-breakout, lodging regex negative control, PrintButton arrival-order flag.
19. Optional CSP `frame-ancestors 'none'` in `public/_headers` (low-risk header-only).
20. Playwright smoke in CI against mocked NDJSON (CLAUDE.md already specifies the mock format) — the only way to catch “HotelCard never rendered `flags`” again.

---

## What this review is not

- Not a live pass against `https://www.routesmith.ai` or `https://aripshitadventure.com`. This environment’s egress may block the production host (CLAUDE.md). Claims above are from the tree at `6e8814c`.
- Not a model-quality review of itinerary prose. Deterministic checkers in `src/*Check.js` are the right layer; they look intentionally battle-tested.
- Not a request to merge architecture refactors. Splitting `App.jsx` would be a large, high-regression project; P0/P1 items above are smaller and higher leverage.

**Critical + tiny** items that could be a follow-up patch without a redesign: (3) JSON script escape, (7) footer domain, (9) clipboard catch. Auth on Functions is not tiny.
