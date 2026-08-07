# Trip Optimizer — Project Wiki

Curated reference for the Trip Optimizer project. This wiki lives in the repo at `docs/wiki/` and travels with every `gh repo clone`. Read this first to get oriented before doing any work.

**Repo:** [jhwiv/trip-optimizer](https://github.com/jhwiv/trip-optimizer) (public, default branch `master`)
**Live:** https://www.routesmith.ai (also reachable at https://trip-optimizer-6og.pages.dev)
**Mode:** Maintenance / feature-complete. Larger architectural changes need explicit approval.
**Wiki origin:** Built 2026-06-27 during a long session that merged PRs #64–#69. Moved to `docs/wiki/` for cross-session durability.

## What it is

Luxury-tier travel-planning web app. One bundle, two surfaces:

- **`/`** — Full itinerary build. Three-step wizard (Essentials → Details → Your plan) that turns a free-text trip brief into a day-by-day itinerary with hotels, restaurants, activities, ground transport.
- **`/find`** — Quick search. Single-screen lookup for restaurants and activities in a given location, with an automatic "locals' picks" pass appended below the standard results.

## Catalog

- **`handoff.md` — read first** when starting a new thread. One-page state-of-the-world.
- `projects/trip-optimizer.md` — overview, current status, recent merges, next steps
- `entities/repo-and-deploy.md` — repo, hosting, environment vars, CI, scripts
- `concepts/architecture.md` — routing, frontend modules, Pages Functions API surface
- `concepts/api-endpoints.md` — every `/api/*` endpoint and what it does
- `concepts/conventions.md` — project conventions, testing, lint, PR norms
- `concepts/verification-workflow.md` — standard manual verification procedure for PRs
- `concepts/known-issues.md` — outstanding non-blocking infra/QA gaps
- `concepts/build-stall-watchdog.md` — #24 diagnosis: live-stream stall watchdog + adaptive KV-poll budget
- `concepts/flight-resolver-gaps.md` — #12 follow-up diagnosis: two coverage gaps in `FlightNumberAutoResolver` (API miss + resolver skips when number exists), production probe data, authorized fix shape
- `concepts/final-4-roadmap.md` — consolidated execution brief for the four remaining items (#22, #6, #7, #15): status, test scenarios, technical dependencies, and experiment design
- `learnings/2026-06-27.md` — full work log for the day PRs #64–#69 shipped
- `learnings/2026-06-30.md` — work log for the day PRs #96–#102 shipped; #6 parked; flight-numbers investigation opened
- `learnings/2026-07-03.md` — work log: shareable URL, activity count hardening, PDF whitespace, iOS offset fix
- `learnings/2026-08-03.md` — build-hero redesign, `contain: paint` removal (fixed-position containing-block bug); two subsequent attempts at a recurring right-edge clipping report — the WebKit/WKWebView stale-viewport-unit fix (`100vw`/`100dvw` removed), which the user tested and reported failed, and the current unconfirmed hypothesis (16px minimum form-field font-size, to prevent iOS auto-zoom-on-focus); the build-progress card's solid-white-vs-translucent-glass fix; an itinerary-quality audit (same-day duplicate venues, marquee-sight "promised but not scheduled" detection, MUST-prefix parsing) triggered by a reviewed Sedona PDF; a root-cause audit finding one field-name bug (`item.name` doesn't exist on `DAY_ITEM_SCHEMA`) had silently disabled Places verification for every Activity item, the Expert Review's live-retrieval grounding, and chunk-mode cross-chunk restaurant dedupe (`CLAUDE.md`'s "KNOWN FAILURE MODE"); an independent peer review catching two real bugs; feeding quality warnings into the Expert Review, which exposed a one-letter `input`/`inputs` parameter mixup that had silently disabled the entire marquee-coverage check forever (`CLAUDE.md`'s "KNOWN FAILURE MODE #2"); and a second reviewed Sedona PDF showing the same-day duplicate bug is systemic across venue kinds (fixed for Activities, not just restaurants), plus two new checks (missing dinner, stray booking reference) and a live-only-caught regex fragility in the second one
- `concepts/activity-count.md` — complete root-cause analysis and fix history for the "too many activities" recurrence
- `learnings/2026-08-04.md` — a real 14-night 5-city build's PDF export blocked by a false-positive `DAY_CITY_DISCONTINUITY` (fixed in `dayContinuityCheck.js`, confirmed live via a browser `download` event before/after); a Save-trip-button false-positive "Saved" on a storage write failure; stage 1 of an itinerary-build → deployable-site pipeline (`scripts/publish-trip-site.mjs`), informed by cloning and reading this account's own three real trip-site repos rather than guessing; a mount-time build-resume effect that could silently hijack the app into a token-consuming rebuild instead of showing the home screen or a saved trip — now an explicit Resume/Discard choice (`CLAUDE.md`'s "KNOWN FAILURE MODE #4"); a build screen showing only the first city on a multi-city trip, fixed with a shared `basicsDestinationLabel()` helper across five call sites; PDF-save errors collapsing a specific, actionable gate reason down to a useless generic message in production; a user-requested targeted pattern-based sweep for the day's other bug shapes, which found the `input`/`inputs` parameter mixup (KNOWN FAILURE MODE #2) recurring twice more in `applyQualityLayer`, silently disabling the restaurant-closure safety gate the whole time (`CLAUDE.md`'s "KNOWN FAILURE MODE #5"); and two more `dayContinuityCheck.js` false positives (a same-day round-trip misread as a re-arrival, and a travel day whose route text names real towns rather than the region label used as the city) found on a same-day rebuild of the trip from the DAY_CITY_DISCONTINUITY fix, with a first-attempt fix that regressed the module's own original regression fixture before landing on the right signal (`CLAUDE.md`'s "KNOWN FAILURE MODE #6"); and a night-math bug (`legNights.js`) from a second independent PDF review of the same trip — a meta-line auto-corrector regex that only matched one of two model-written formats, plus per-city night counts that trusted a transit day's own city label instead of its actual hotel check-in/check-out events (`CLAUDE.md`'s "KNOWN FAILURE MODE #7"); and, from the same review, a carrier-correction bug where rewriting a flight's carrier to match a known-nonstop route left the OLD carrier's flight number (e.g. "LO 15" surviving a LOT→United rewrite) attached to the corrected carrier, plus a same-day follow-up where that same correction left three top-level tonight/logistics/flags entries still describing the flight under its original carrier and routing (`CLAUDE.md`'s "KNOWN FAILURE MODE #8")
