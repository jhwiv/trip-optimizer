# Trip Optimizer (RouteSmith) — Handoff (2026-06-30, 3:25 PM EDT)

> One-page state of the world. Read this first when picking up Trip Optimizer / RouteSmith in a new thread. Then read `index.md` for the rest of the wiki.

## Repo & deploy

- **Repo:** [jhwiv/trip-optimizer](https://github.com/jhwiv/trip-optimizer) · default branch `master`
- **Live:** [www.routesmith.ai](https://www.routesmith.ai) (canonical) · also `trip-optimizer-6og.pages.dev`
- **Hosting:** Cloudflare Pages + Pages Functions; Anthropic Sonnet 4.5 for builds; Perplexity Sonar for retrieval; KV (`JOBS`) for cache/job state
- **CI gates (all required on every PR to master):** Unit tests (`tests/run-all.mjs`), ESLint (0 errors), Vite build, Hex-leak baseline, Contrast audit (WCAG AA). Cloudflare Pages preview + Cursor Bugbot are non-blocking.

## ACTIVE INVESTIGATION (do this BEFORE any remaining update-list item)

**Flight numbers and times sometimes missing from the build + PDF.** User reported on 2026-06-30 PM, framed as "the fix gets reverted." Static audit found **no regression in the repo**: every commit since PR #84 (the #12 fix, `471d969`, 2026-06-29) was audited; none touched flight-pipeline lines. `git blame` on every anchor line traces to PR #84. The live bundle contains the full fix. **The code is intact.**

The bug is real, but it's two coverage gaps PR #84 did NOT cover, firing under different inputs build-to-build. **Diagnosis page (read this before any code):** [`concepts/flight-resolver-gaps.md`](concepts/flight-resolver-gaps.md) — contains code anchors, the production `/api/flights-search` probe data (6 of 8 routes hit; the recoverable false-negative is the airline-filter case), and the user-authorized fix shape.

**User authorized "Go on the shape as described"** 2026-06-30 PM. Summary:

1. Loosen the Gap 2 bail at `App.jsx ~6469` so flights with a number but no times still query `/api/flights-search` for times-only backfill (never overwrite a present number).
2. Airline-filter → route-only retry on Gap 1 API miss. Route-only results contribute **times only**, never numbers (cross-carrier number leakage risk).
3. Persist `_timesUnconfirmed: true` and render an honest "Times not yet confirmed — check with airline at booking" fallback in the PDF when neither attempt resolves AND the model omitted windows.
4. Add `tests/test_flight_resolver.mjs` with four cases: omit-both → fallback; number-only → backfill; emit-everything → no resolver call; airline-filter miss → route-only retry recovers.
5. Live confirmation: Denver UA build (known-good); EWR-LAX-AA build (airline-filter recovery); JAC-FLG build (true miss → fallback string).

No code yet. PR opens off current master after the user confirms the shape against the diagnosis page.

## Update-list status

The original 15-item list grew to 24 via live testing. Working in waves, one focused PR at a time, each verified live on www.routesmith.ai after merge (preview can't run builds — no API keys; see infra note).

| # | Item | Status | PR |
|---|------|--------|----|
| 1 | Reset button on hero | ✅ Merged + verified live | #80 |
| 2 | Continue → Trip style on both mobile & desktop | ✅ Merged + verified live | #80 |
| 3 | Budget: allow multiple price ranges | ✅ Merged + verified live | #80 |
| 4 | Preselect outputs (all but last 2) | ✅ Merged + verified live | #80 |
| 5 | Dynamic build-time estimate | ✅ Merged + verified live | #80 |
| 6 | No "preparing introduction"; go to top/Overview | ⚪ **PARKED** by user 2026-06-30 (diagnosis: only on-screen "Preparing introduction…" string is the Save-as-PDF gate while the headless intro generator runs; not a visible layout drop). Don't pick up unless user revisits. | — |
| 7 | Hotel-swap re-resolves dependent activities | ⬜ Not started | — |
| 8 part 1 | Auto-run expert review on build completion | ✅ Merged + verified live | #90 |
| 8 part 2a | Pre-build expert-review source picker | ✅ Merged + verified live | #91 |
| 8 part 2b | Apply-mode toggle (auto-apply default vs approve-each) | ✅ Merged + verified live | #101 |
| 9 | App intro (A2HS, what it is/isn't, how-to) | ✅ Merged + verified live | #102 |
| 10 | Collapse expert-review section to one line after Apply | ✅ Merged + verified live | #100 |
| 11 | Overview/cards → tabbed view | ⬜ Not started; **architecture proposal in flight** when user pivoted to flight-numbers issue. See "#11 architecture options" below. | — |
| 12 | PDF missing flight numbers (+ slow) | ✅ Merged + verified live (PR #83 reverted; PR #84 is the correct fix). **Follow-up in flight:** see `concepts/flight-resolver-gaps.md` for the two coverage gaps; not a code revert. | #84 + follow-up |
| 13 | Remove gold; navy + silver palette | ✅ Merged + verified live | #79 |
| 14 | Day-scoped activity count ("1 activity on one day" → 1 every day) | ✅ Merged + verified live | #81 |
| 15 | Toggle: narrate build request vs manual dropdowns | ⬜ Not started | — |
| 16 | Build/narrative button navy-on-navy (invisible) | ✅ Merged + verified live | #86, #87 |
| 17 | In-build caption "2–3 min" vs dynamic estimate | ✅ Merged + verified live | #86 |
| 18 | "2 activities" trip-TOTAL gave 9 (extends #14 to whole-trip) | ✅ Merged + verified live | #99 |
| 19 | Live flight-status panel CORS-blocked | ✅ Merged + verified (proxy 200, no CORS; panel-render not re-tested) | #88 |
| 20 | Outputs-step landed on review picker, not top | ✅ Merged + verified live | #92 |
| 21 | Hotel cards lacked website link | ✅ Merged + verified live | #94 |
| 22 | Expert review "Apply" — reported broken | 🔎 **Open, awaiting user re-test** — reproduced live and Apply DID work (~2.5 min full re-plan); likely the now-fixed invisible buttons (#23) made it feel broken. | — |
| 23 | More navy-on-navy (review findings + tab pills) | ✅ Merged + verified live | #93 |
| 24 | Live-stream stall watchdog + adaptive KV-poll budget | ✅ Merged + verified live | #97 |

**TRUE Score: 20 of 24 merged. 4 remaining (#7, #11, #15, plus #22 awaiting re-test). #6 parked.**

## Remaining (in user's preferred order)

1. **Flight numbers/times investigation** (above) — DO THIS FIRST when picking back up, per user direction 2026-06-30 PM.
2. **#11 Tabbed Overview/Flights/Hotels/Activities** — biggest UX leverage left. The post-build screen is already tabbed today (9 tabs). Wiki entry likely meant "collapse to 4–5 primaries + More overflow." Confirm interpretation before coding. Options on the table when user pivoted:
   - **B-prime** (recommended): 5 primaries (Overview · Flights · Hotels · Dining · Activities) + "More ▾" (Transport, Local providers, Essentials, By category)
   - **B literal**: 4 primaries (wiki spec) + everything else in More
   - **A**: just rename Lodging → Hotels, leave strip alone
   - **C**: rework Overview into a true at-a-glance summary; keep 9 tabs
3. **#7 Hotel-swap dependency resolution** — touches swap pipeline; design-spec'd, build later.
4. **#15 Narrate vs dropdowns toggle** — largest unknown; touches the build prompt pipeline. Scope separately.
5. **#22 Apply broken** — awaiting user re-test now that #23 invisible-button regressions are well-shipped.

Parked:
- **#6** — per user 2026-06-30. Don't pick up unless user explicitly asks.
- **Manifest rebrand** — `public/manifest.webmanifest` still says `"name": "Trip Optimizer"` / `"short_name": "Trip"`. Not part of any merged PR. Park until user calls it.

## Expert-review cluster — COMPLETE

Cluster wrapped 2026-06-30 PM. All four sub-items shipped and verified live:
- **#8 part 1** — `ReviewPanel` auto-runs on fresh build (autoRun guarded once per build, mirrors IntroductionAutoGenerator). autoReview = !initialReview. Shipped PR #90.
- **#8 part 2a** — reviewerSourceIds lifted to wizard state (region-aware default); compact picker card in the outputs step; feeds the pre-build `/api/review-retrieve` pass + ReviewPanel (externalSourceIds). Shipped PR #91.
- **#8 part 2b** — apply-mode toggle ("auto" default vs "approve_each") in the picker card; auto-apply effect fires `handleApply` with `findingsOverride` once per review; once-per-review `autoApplySigRef` guard; persisted via `apply_mode_choice` in `onReviewChange`. Shipped PR #101.
- **#10** — collapse the done card to a one-line summary after a successful Apply (or when a restored saved trip carries applied findings); partial-apply intentionally stays expanded so "Re-plan to apply the rest" stays one tap away. Shipped PR #100.

## #9 App intro — DONE

PR #102 (merged 2026-06-30). Full-screen first-visit overlay with What it is / What it isn't / How to use it cards, A2HS pills (iOS / Android / Desktop, auto-expand to user's platform), "Start planning" CTA, BID studio branding. Pure gate logic in `src/appIntro.js` (localStorage gate, `?direct=1` bypass, standalone-PWA bypass, platform detection) with 30 unit tests in `tests/test_app_intro.mjs`. Live bundle `index-B_4BBtOR.js` verified to contain `routesmith-welcomed-v1`, the three card labels, and the BID footer.

## Process lessons (read these before coding)

### #24 — Revise diagnosis before coding
The first wiki entry for #24 said "harden the 180s threshold + decouple #8 auto-review." Reading the actual code revealed both claims were wrong: the live stream had no stall watchdog at all (only the KV-poll fallback did), and the #8 auto-review was already structurally decoupled by mount order. Shipped fix matched the actual bug. **Lesson: a wiki diagnosis written from memory is a hypothesis. Always re-verify against source before opening the code branch. Update the wiki when the diagnosis revises.**

### #18 — Lost-branch recovery
When the sandbox died mid-session, `fix/trip-total-activity-count` was reported as "pushed, CI green, awaiting PR" — but a thorough check (no remote branch, no CI run, no PR with the title) confirmed it was lost. Re-derived from scratch as a prompt-only fix mirroring #14 in PR #99. **Lesson: when recovering a lost branch, verify on origin (`git ls-remote`), CI history (`gh run list`), and PR list (`gh pr list --state all`) before trusting any prior-session claim that work was pushed.**

### #19 — Verification rigor
#12's flight NUMBER tested fine, but the live-status panel (different path, shared worker CORS allowlist) was broken and a single happy-path test missed it. **Lesson: "verified live" = the path I tested works, stated per item — NOT exhaustive coverage. State the path explicitly.**

### Bundle verification standard
After every merge: confirm the new bundle is live by curling www.routesmith.ai and grep'ing the served JS for signature strings unique to the change. Include regression-guard greps for prior PRs' signatures in the same check. Examples used this session:
- #18: `TRIP-TOTAL REQUESTS`, `WHOLE-TRIP CAP`
- #24: `Live stream paused`, `Live stream stalled`, `no events for 90s`
- #14 regression guard: `DAY-SCOPED REQUESTS`
- #8 part 2b: `When findings land`
- #9: `routesmith-welcomed-v1`, `Add to your home screen`, `Not a booking engine`

## #12 — Reference (the previously-shipped fix)

Fixed via PR #84 (PR #83 was reverted — it mutated the post-`applyQualityLayer` copy, which the layer re-stripped and the `useMemo` re-cloned, so the number never reached the PDF). Correct fix: headless `FlightNumberAutoResolver` (App.jsx ~6451) resolves missing numbers from `/api/flights-search` and persists them to the canonical plan via `onPlanRevised` flagged `_scheduleVerified`; `applyQualityLayer` exempts `_scheduleVerified` numbers from the strip (~line 2914); PDF reads `fl.flight_number` (itineraryPdf.js:1043) with a self-prefix check and renders a "Verify — scheduled operating flight, confirm at booking" qualifier when `_autoResolvedFlightNumber` is set. Verified on production: Denver build → PDF showed UA670 / UA2345 matching screen.

**Lesson: persist async-resolved data to the canonical plan (rawData via onPlanRevised), never mutate the rendered copy.**

**Known gaps (see Active Investigation above):** PR #84 covers "model omits number, API has a match." It does NOT cover (Gap 1) API miss → flight stays bare, or (Gap 2) model emits number but no times → resolver short-circuits and times stay blank.

## #13 branding detail (reference)
`--color-gold` token retired → navy/silver. All fill sites flipped to `ON_NAVY` text to avoid navy-on-navy. PDF `COLOR.gold`→navy. theme-color/manifest→navy. Earlier stale branches `palette-bid`, `palette-leaks`, `chore/qa-contrast-hex-visual` already had their content on master — safe to delete (not yet deleted, per user not authorizing branch deletion).

## #14 verification detail (reference)
Live build on www.routesmith.ai, narrative: "only ONE activity on Day 3, keep it light; other days normal." Result per day — D1: 1 (arrival), D2: 3, D3: 1 + dinner, D4: 3, D5: 1 (departure). Day-scope honored, did NOT propagate. Fix was prompt-only (DAY-SCOPED REQUESTS rule + activities-pool reframing in `App.jsx`). `build.js` (streaming proxy) and `chunkPlan.js` (token chunking) not involved.

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
3. **Pick up the Active Investigation (flight numbers/times) FIRST.** That's where the user paused work.
4. Then resume the remaining list in user's preferred order: #11 (confirm interpretation before coding) → #7 → #15 → #22 (awaiting user re-test).
5. One focused PR at a time, green CI, verify live after merge. **No code without user "go".**
6. Update this wiki in the same PR that changes meaningful state.

## How to keep this wiki current

- Lives in-repo at `docs/wiki/` — every clone gets it.
- Update wiki files in the same PR that changes the corresponding state.
- Dated work logs under `learnings/YYYY-MM-DD.md`. Persistent facts under `entities/` or `concepts/`.
- Keep `handoff.md` as the single "where are we right now" — rewrite it freely.
