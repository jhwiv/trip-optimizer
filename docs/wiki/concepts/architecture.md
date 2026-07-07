# Architecture

## Routing

Routing lives in `src/main.jsx`, **before** any component tree mounts:

- Regex `/^\/find(\/|\?|$)/` decides whether `App` (default export of `App.jsx`, the wizard) or `FindView` (named export) renders.
- This sidesteps React's rules-of-hooks because there is no early return inside a hook-using component.
- No client-side router beyond this single branch — both surfaces are SPA pages with their own complete UI.

## Frontend modules (`src/`)

- `App.jsx` — wizard (Essentials → Details → Your plan) for the `/` surface. Includes `IntroductionAutoGenerator` (headless component at ~line 6088).
- `main.jsx` — entry + routing branch (`/find` vs root)
- `categoryGroups.js` — "By category" grouped view (PR #63)
- `chunkPlan.js` — chunked-build plumbing for large trips (PRs #51, #52)
- `dateFacts.js` — computed-date helpers used by venue verification
- `flightSelect.js` — flight selection / display (PRs #59, #62)
- `hoursParser.js` — hours parsing for OPEN_ON_THIS_DAY / OUTSIDE_HOURS (PR #43)
- `introduction.js` — pure helpers (`shapeIntroRequest`, `applyGeneratedIntroduction`, `hasIntroduction`, `introPlanSignature`, `buildIntroPromptForExternalAI`). Tested by `tests/test_introduction.mjs` (~47 assertions).
- `localProviders.js` — Local providers feature (PR #65)
- `locationCheck.js` — WRONG_LOCATION block for venues outside trip radius (PR #45)
- `outputsState.js` — Output selections preserved across remounts (PR #64)
- `pacingCheck.js` — PACING_IMPOSSIBLE / PACING_CONFLICT travel-time grounding (PR #46)
- `placesVerify.js` — Google Places verification + name-similarity guard (PRs #41, #42, #44)
- `replanControl.js` — Re-plan stream control (PR #66)
- `swapAlternatives.js` — "Find another restaurant/activity" swap on itinerary cards (PR #60)
- `useViewport.js` — viewport hook
- `pdf/itineraryPdf.js` — PDF generation. `renderIntroduction` ~line 654, called ~line 1602 (after cover, before day-by-day). Reads `data.introduction.{arc,differentiators}`. Exports shared layout primitives (`makeCursor`, `COLOR`, `FONT`, `PAGE`, `mapsUrl`, `telUrl`, `asciiSafe`, `to12h`, `safe`, `titleCase`) reused by `pdf/findPdf.js`.
- `pdf/findPdf.js` — PDF export for `/find` (local-info-only) results. Sibling to `itineraryPdf.js`, reuses its cursor/hyperlink primitives but lays out the flatter restaurant/activity list shape (no days/flights/hotels). `buildFindPdf(payload, options)` — payload is `{ location, category, guidelines, restaurants, activities, localExpert, note }` mirroring `FindView`'s `results` state. Every phone/website/booking/address renders as a live clickable link, same mechanism as the itinerary PDF.

## API surface — Cloudflare Pages Functions (`functions/api/`)

See `concepts/api-endpoints.md` for the full endpoint table.

## Build pipeline

- **Chunked builds for large trips** (PR #51): split day ranges into chunks + wrapper, stitched together.
- **Auto-resume** (PR #52): recover finished chunks from KV; re-run only the missing ones.
- **Bounded stream** (PR #64): stalled build stream is bounded; output selections preserved across remounts.

## Verification chain (venue hardening)

Multi-pass check before a venue makes it into the final plan:

1. Google Places lookup (`places-verify.js`)
2. Name-similarity guard against fuzzy matches (PR #42)
3. Hours / day-of-week check — `OPEN_ON_THIS_DAY`, `OUTSIDE_HOURS` (PR #43)
4. Wrong-location radius check — `WRONG_LOCATION` (PR #45)
5. Routes API travel-time grounding — `PACING_IMPOSSIBLE`, `PACING_CONFLICT` (PR #46)
6. Batch verification chunked under the Workers subrequest cap (PR #44)
7. Pre-export gate (PR #41)

## Review / re-plan

- **Professional Review** with honest partial-apply (PR #54) — doesn't claim un-applied fixes
- **Surgical Expert-Review apply** resumes via KV poll when the live SSE stream drops (PR #68)
- **Full re-plan** mid-stream aborts now surface honest errors instead of bare "Load failed" (PR #66)

## PDF

- Cover → introduction (PR #67) → day-by-day → optional grouped-by-category view (PR #63)
- Dining cards have OpenTable / Resy chips (PR #40)
- 12-hour AM/PM time everywhere (PR #55)

## Introduction flow (PRs #67 + #69) — CRITICAL CONTEXT

`IntroductionAutoGenerator` is a **headless** component (renders `null`) mounted in the results view. After build completes, it fires `POST /api/introduction` in a `useEffect`, then calls `applyGeneratedIntroduction(plan, data, { force: false })` to populate `data.introduction` and lifts via `onPlanRevised`. The PDF chain in `pdf/itineraryPdf.js` reads `data.introduction.{arc,differentiators}` at render time.

**Important:** Nothing currently gates the PDF download button on the headless generation completing. This is the active race-condition bug (see `handoff.md`).
