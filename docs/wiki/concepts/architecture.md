# Architecture

## Routing

Routing lives in `src/main.jsx`, **before** any component tree mounts:

- Regex `/^\/find(\/|\?|$)/` decides whether `App` (default export of `App.jsx`, the wizard) or `FindView` (named export) renders.
- This sidesteps React's rules-of-hooks because there is no early return inside a hook-using component.
- No client-side router beyond this single branch — both surfaces are SPA pages with their own complete UI.

## Frontend modules (`src/`)

- `App.jsx` — wizard (Essentials → Details → Your plan) for the `/` surface. Includes `IntroductionAutoGenerator` (headless component at ~line 6088).
- `main.jsx` — entry + routing branch (`/find` vs root)
- `bookingUrlCheck.js` — vendor booking-link plausibility + dead-link stripping (`BOOKING_URL_IMPLAUSIBLE`, `BOOKING_URL_DEAD`)
- `categoryGroups.js` — "By category" grouped view (PR #63)
- `chunkPlan.js` — chunked-build plumbing for large trips (PRs #51, #52)
- `dateFacts.js` — computed-date helpers used by venue verification, plus `assertWeekdayClaims` (`WEEKDAY_CLAIM_MISMATCH`)
- `dayContinuityCheck.js` — day-to-day structural continuity (`DAY_CITY_DISCONTINUITY`, `DUPLICATE_CHECKIN`, `ORPHANED_TRANSITION`, `CITY_BACKTRACK`, `VEHICLE_STATE_CONFLICT`)
- `flightSelect.js` — flight selection / display (PRs #59, #62)
- `flightTimeConsistency.js` — Flight item header time vs `flight.depart_time` (`FLIGHT_TIME_MISMATCH`)
- `legNights.js` — contiguous city-run night math; reconciles `meta` / `cities[].nights` (`NIGHT_COUNT_MISMATCH`)
- `hoursParser.js` — hours parsing for OPEN_ON_THIS_DAY / OUTSIDE_HOURS (PR #43)
- `introduction.js` — pure helpers (`shapeIntroRequest`, `applyGeneratedIntroduction`, `hasIntroduction`, `introPlanSignature`, `buildIntroPromptForExternalAI`). Tested by `tests/test_introduction.mjs` (~47 assertions).
- `localProviders.js` — Local providers feature (PR #65)
- `locationCheck.js` — WRONG_LOCATION block for venues outside trip radius (PR #45)
- `nameMatch.js` — pure name-similarity primitives (`normalizeNameForCompare`, `diceCoefficient`, `isSimilarEnough`, `nameMatchScore`). Shared by `functions/api/places-verify.js` and the client so both score a match the same way
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

### Hotels

Hotels ran outside this chain until PR #149 — the plan's restaurants and
activities were verified while the property the traveller was actually sleeping
in was taken on the model's word. A permanently-closed or invented hotel
exported clean. Hotels now go through the same batch as every other venue, with
three deliberate differences:

**No hours check.** Steps 3's `CLOSED_ON_THIS_DAY` / `OUTSIDE_HOURS` never fire
for a hotel. This is the 2026-06-14 exemption and it is kept on purpose: hotel
reception is generally 24/7, Places hours data for hotels is sparse and often
describes a restaurant or spa inside the property, and a 3 PM check-in against
missing hours produces a false "closed" on a correct booking. The exemption is
about *hours only* — existence and `business_status` are checked exactly as they
are for a restaurant.

**Blocked hotels are flagged, not dropped.** Restaurants and activities with a
block flag are removed from the plan. A hotel is load-bearing structure: drop it
and the traveller has an itinerary with no bed, and the duplicate-check-in and
city-continuity validators lose the item they reason about. The flag rides on
`item.hotel.flags[]` and `findBlockingIssues()` refuses the export.

**Name ambiguity warns; only `business_status` blocks.** "Marriott Marble Arch"
and "Marriott Regents Park" are three bigrams apart, and chain naming makes a
wrong-branch match the common failure. A confident write-through of Places'
address/phone onto `item.hotel` requires `nameMatchScore >= 0.80`; below that the
property keeps the model's name, has its phone and street address stripped, and
carries `HOTEL_MATCH_UNCERTAIN` (warn). The server's own 0.55 guard, which turns
a name mismatch into a `NOT_FOUND` **block** for other kinds, is downgraded to
that same warn for `kind:"hotel"` in `flagsFor()`.

Whether the property is in the right *city* is answered geographically, not
lexically: hotels are included in step 4's radius check
(`findVenuesOutsideRadius(..., { kinds: ["restaurant","activity","hotel"] })`).
Comparing Places' address string to the itinerary's city name false-positives on
every exonym — Venice/Venezia, Munich/München, Lisbon/Lisboa — and telling a
traveller their correct hotel is in the wrong city is worse than not checking.
Coordinates have no language.

Cost: one Places lookup per *unique* hotel per build. `collectPlanVenues` dedups
by name + address, so a property checked into on Day 1 and out of on Day 3 is one
lookup, not two. Measured on the four-day two-city fixture in
`tests/qa_structural_gate.mjs`: 4 lookups before, 6 after.

## Structural validation (itinerary hardening)

The chain above checks one venue at a time and cannot see a plan that is
internally contradictory — a hotel checked into on two days, a header time that
disagrees with its own flight, a weekday claim that contradicts the date. A
parallel chain of pure validators checks the shape of the itinerary and feeds
the same pre-export gate via `day.structural_flags[]`:

`dayContinuityCheck.js` · `legNights.js` · `dateFacts.js` ·
`flightTimeConsistency.js` · `bookingUrlCheck.js` · `flightResolver.js`

See `concepts/structural-validation.md` for the full chain and
`CLAUDE.md` for the flag taxonomy.

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
