# Trip Optimizer (RouteSmith) — Handoff (2026-06-29, 4:11 PM EDT)

> One-page state of the world. Read this first when picking up Trip Optimizer / RouteSmith in a new thread. Then read `index.md` for the rest of the wiki.

## Repo & deploy

- **Repo:** [jhwiv/trip-optimizer](https://github.com/jhwiv/trip-optimizer) · default branch `master`
- **Live:** [www.routesmith.ai](https://www.routesmith.ai) (canonical) · also `trip-optimizer-6og.pages.dev`
- **Hosting:** Cloudflare Pages + Pages Functions; Anthropic Sonnet 4.5 for builds; Perplexity Sonar for retrieval; KV (`JOBS`) for cache/job state
- **CI gates (all required on every PR to master):** Unit tests (`tests/run-all.mjs`), ESLint (0 errors), Vite build, Hex-leak baseline, Contrast audit (WCAG AA). Cloudflare Pages preview + Cursor Bugbot are non-blocking.

## Active workstream: the 15-item update list (2026-06-29)

User supplied a 15-item update list (item 16 blank). Working in waves, one focused PR at a time, each verified live on www.routesmith.ai after merge (preview can't run builds — no API keys; see infra note). Status:

| # | Item | Status | PR |
|---|------|--------|----|
| 1 | Reset button on hero | ✅ Merged + verified live | #80 |
| 2 | Continue → Trip style on both mobile & desktop (was Flights on mobile) | ✅ Merged + verified live | #80 |
| 3 | Budget: allow multiple price ranges | ✅ Merged + verified live (4 multi-select pills) | #80 |
| 4 | Preselect outputs (all but last 2: Badges, Pronunciation off) | ✅ Merged + verified live (10/12 checked) | #80 |
| 5 | Dynamic build-time estimate (was static "3–15 min") | ✅ Merged + verified live (fallback + "~7–13 min" dynamic) | #80 |
| 13 | Remove gold; navy + silver, no big color blocks | ✅ Merged + verified live (0% gold) | #79 |
| 14 | "1 activity on one day" gave one every day | ✅ Merged + **verified live** | #81 |
| 12 | PDF missing flight numbers (+ slow) | ✅ Merged + **verified live** (PDF shows numbers) | #84 (supersedes reverted #83) |
| 6 | No "preparing introduction"; go to top/Overview; auto post-build review | ⬜ Not started (expert-review cluster) | — |
| 7 | Hotel-swap re-resolves dependent activities (e.g. bar drinks) | ⬜ Design spec'd, build later | — |
| 8 | Auto expert-review + pre-build source picker | ⬜ Not started — **mostly already built in code** | — |
| 9 | App intro (Add to Home Screen, how-to, what it is/isn't) | ⬜ Not started | — |
| 10 | Collapse expert-review section to one line after rebuild | ⬜ Not started (expert-review cluster) | — |
| 11 | Overview vs cards → tabbed view (Overview / Flights / Hotels / Activities) | ⬜ Not started | — |
| 15 | Toggle: narrate build request vs manual dropdowns | ⬜ Not started | — |

### Added after the original 15 (surfaced by live testing)
| 16 | Build/narrative button navy-on-navy (invisible) | ✅ Merged + verified live | #86, #87 |
| 17 | In-build caption hardcoded "2–3 min" vs dynamic hero estimate | ✅ Merged + verified live | #86 |
| 18 | "2 activities" trip-TOTAL gave 9 (extends #14 to whole-trip) | ⬜ Not started (prompt fix) | — |
| 19 | Live flight-status panel CORS-blocked (shared worker allowlist) | ✅ Merged + verified (proxy 200, no CORS; panel-render not re-tested) | #88 |

**TRUE Score: 16 of 23 merged (list grew 15→23 via live testing). 7 remaining.**

Done & merged (all deployed to prod):
- Original list: #1, #2, #3, #4, #5, #12, #13, #14
- Expert-review cluster (partial): #8 part 1 (auto-run review on build, PR #90), #8 part 2a (pre-build source picker, PR #91)
- From live testing: #16 (build-button contrast, #86/#87), #17 (estimate caption, #86), #19 (flight-status CORS proxy, #88), #20 (outputs-step scroll-to-top, #92), #21 (hotel website links, #94), #23 (review/tab contrast, #93)

Investigated, NO fix shipped: **#22** ("Apply doesn't work") — reproduced live and apply DID work (~2.5 min full re-plan); likely the now-fixed invisible buttons (#23) made it feel broken. Awaiting user re-test before any code change.

Remaining (7): **#6 + #10 + #8 part 2b** (finish expert-review cluster — NEXT), #18 (trip-total activity count), #7 (hotel-swap deps), #9 (app intro/A2HS), #11 (tabbed view), #15 (narrate toggle).

### Expert-review cluster status
- #8 part 1 DONE: ReviewPanel auto-runs on fresh build (autoRun, guarded once per build, mirrors IntroductionAutoGenerator). autoReview = !initialReview.
- #8 part 2a DONE: reviewerSourceIds lifted to wizard state (region-aware default); compact picker card in the outputs step; feeds the pre-build /api/review-retrieve pass + ReviewPanel (externalSourceIds).
- #8 part 2b TODO: apply-mode toggle (auto-apply default w/ changelog vs approve-each). Approve-each already exists (per-finding applyState + handleApply); auto-apply is the new path.
- #6 TODO: kill the "preparing introduction" drop on completion; land at top/Overview; surface findings.
- #10 TODO: collapse the review section to one line ("Expert review · Revalidate") after a rebuild.

### New items from live testing (16–23)
| 16 | Build/narrative button navy-on-navy | ✅ #86/#87 |
| 17 | In-build caption "2-3 min" vs dynamic estimate | ✅ #86 |
| 19 | Live flight-status CORS-blocked → same-origin proxy | ✅ #88 |
| 20 | "Jump to select outputs" landed on review picker not top | ✅ #92 |
| 21 | Hotel cards lacked website link (now like restaurants) | ✅ #94 |
| 22 | Expert review "Apply" — reported broken; not reproduced | 🔎 open, user re-testing |
| 23 | More navy-on-navy (review findings + tab pills) | ✅ #93 |

### #8 wiring (build from this — already investigated)
Much exists: `REVIEWER_SOURCES` (~8710), `REVIEWER_LENSES` (~8793), region default selection (~5097). `ReviewPanel` (~5070) = self-contained state machine with picker + `handleRunReview` (~5153), mounted POST-build (~6654). A PRE-build pass already fires `/api/review-retrieve` in `handleBuild` (~12771) using hardcoded `defaultSourceIds` (~12797). Build completes ~12047. So #8 = (1) lift source selection to wizard state pre-build, (2) feed picked IDs into the ~12797 pass, (3) auto-fire review at completion (guard once; mirror IntroductionAutoGenerator/FlightNumberAutoResolver). Apply-mode toggle ("both, user toggles") is the only net-new piece.

### #19 process lesson (verification rigor)
#12's flight NUMBER tested fine, but the live-status panel (different path, shared worker CORS allowlist = santafejune.com only) was broken and a single happy-path test missed it. "Verified live" = the path I tested works, stated per item — NOT exhaustive coverage.

### #14 verification detail (2026-06-29)
Live build on www.routesmith.ai (bundle `index-De_bnJup.js`), narrative: "only ONE activity on Day 3, keep it light; other days normal." Result per day — D1: 1 activity (arrival), D2: 3, **D3: 1 + dinner (as requested)**, D4: 3, D5: 1 (departure). Day-scope honored, did NOT propagate, other days kept full pacing. Fix was prompt-only (2 lines in `App.jsx`): a DAY-SCOPED REQUESTS rule + reframing the activities list as a pool. `build.js` (streaming proxy) and `chunkPlan.js` (token chunking) were not involved.

### #13 branding detail
`--color-gold` token retired → navy/silver. All fill sites flipped to `ON_NAVY` text to avoid navy-on-navy. PDF `COLOR.gold`→navy. theme-color/manifest→navy. The earlier stale branches `palette-bid`, `palette-leaks`, `chore/qa-contrast-hex-visual` already had their content on master — safe to delete (not yet deleted, per user not authorizing branch deletion).

## #12 — DONE (verified live 2026-06-29)

Fixed via PR #84 (PR #83 was reverted — it mutated the post-`applyQualityLayer` copy, which the layer re-stripped and the `useMemo` re-cloned, so the number never reached the PDF; live test confirmed the failure). Correct fix: new headless `FlightNumberAutoResolver` resolves missing numbers from `/api/flights-search` and persists them to the CANONICAL plan via `onPlanRevised` flagged `_scheduleVerified`; `applyQualityLayer` exempts `_scheduleVerified` numbers from the strip; PDF shows the number (self-prefixed, no double-prefix) with a "Verify — scheduled operating flight, confirm at booking" qualifier. Verified on production: Denver build → PDF showed UA670 / UA2345 matching screen. **Lesson: persist async-resolved data to the canonical plan (rawData via onPlanRevised), never mutate the rendered copy.**

## #12 — original root-cause notes (kept for reference)

PDF reads the right field (`itineraryPdf.js:1039` uses `fl.flight_number`) — but that field is often **empty in the plan object**. Two flight-number sources on screen; only one persists:
1. `item.flight.flight_number` — model-emitted; PDF reads this. Model is (correctly) told not to fabricate, so often omitted.
2. `autoFlight.flightNumber` — resolved live from the schedule API at render, shown on screen, lives in React state. Only written back to `item.flight.flight_number` when the user **taps a flight row** (`onFlightConfirmed`, `App.jsx:1457/1588`). Never auto-persisted.

Common path: model omits number → screen auto-shows it → user never taps → `item.flight.flight_number` stays empty → PDF (no React, no API) prints carrier only. **Proposed fix (Option A):** auto-persist the auto-resolved number into `item.flight` on render when the field is empty (reuse the existing `Object.assign` shape from `onFlightConfirmed`), guarded to write once; carry the "verify at booking" honesty qualifier into the PDF. Scoped to that data flow only — no PDF-pipeline rewrite. PDF *slowness* is a separate item, untouched per user rule.

## Open infrastructure work (not blocking)

1. **Cloudflare Pages Preview env vars** — `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `JOBS` KV bound to Production only. Preview builds soft-fail. Until fixed, PR preview verification is impossible for any LLM/build flow → we verify on production after merge. See `concepts/known-issues.md` #1.
2. **Wizard date picker** — hostile to browser automation; blocks full end-to-end smoke tests. See `concepts/known-issues.md` #2.
3. **PDF generation performance** — pre-existing slowness on multi-day itineraries (`jspdf` + `html2canvas-pro`). Item #12 covers flight numbers only; perf is separate and not to be touched without explicit instruction.

## User context / preferences (not optional)

- Skilled JS/React/Cloudflare dev. Direct, terse communication. **No filler, no preambles, no exclamation points.**
- **HARD PREFERENCE: never ask questions as numbered lists/paragraphs in chat — use the interactive checkbox/multiple-choice tool, or plain prose.** User has flagged violations of this repeatedly.
- Windows desktop (not Mac/mobile). Comfortable with `gh` CLI, Cloudflare dashboard, PowerShell.
- **Build process:** minimal/focused fixes; no auto-spawned PRs without explicit "go"; one PR at a time; every PR carries a "Needs live confirmation" checklist; verify on www.routesmith.ai (push + curl/visual confirm before "done"). Do not touch PDF perf or Preview env vars without instruction.
- Owns RouteSmith + several travel apps + RailbirdAI + Vigil Family Records + Barrier Island Digital. Prefers this persistent wiki over re-explaining context.

## What the next thread should do

1. Read this `handoff.md`, then `index.md`, then relevant `concepts/*`.
2. Cross-reference long-term memory for preferences not captured here.
3. Resume the 15-item list: the expert-review cluster is next (#8 → #6 → #10, with #8 mostly pre-built), then #7, then #11/#9/#15.
4. One focused PR at a time, green CI, verify live after merge. No code without user "go".
5. Update this wiki in the same PR that changes meaningful state.

## How to keep this wiki current

- Lives in-repo at `docs/wiki/` — every clone gets it.
- Update wiki files in the same PR that changes the corresponding state.
- Dated work logs under `learnings/YYYY-MM-DD.md`. Persistent facts under `entities/` or `concepts/`.
- Keep `handoff.md` as the single "where are we right now" — rewrite it freely.
