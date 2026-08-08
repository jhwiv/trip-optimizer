# Trip Optimizer (RouteSmith) — Handoff (2026-07-01)

> One-page state of the world. Read this first when picking up Trip Optimizer / RouteSmith in a new thread. Then read `index.md` for the rest of the wiki.

## Repo & deploy

- **Repo:** [jhwiv/trip-optimizer](https://github.com/jhwiv/trip-optimizer) · default branch `master`
- **Live:** [www.routesmith.ai](https://www.routesmith.ai) (canonical) · also `trip-optimizer-6og.pages.dev`
- **Hosting:** Cloudflare Pages + Pages Functions; Anthropic Sonnet 4.5 for builds; Perplexity Sonar for retrieval; KV (`JOBS`) for cache/job state
- **CI gates (all required on every PR to master):** Unit tests (`tests/run-all.mjs`), ESLint (0 errors), Vite build, Hex-leak baseline, Contrast audit (WCAG AA). Cloudflare Pages preview + Cursor Bugbot are non-blocking.

## Flight-number investigation — FULLY CLOSED 2026-07-01

**Seven PRs, one root cause per PR. All render surfaces audited. Pipeline sealed.**

| PR | What it fixed | Gap it left |
|---|---|---|
| #84 | Resolver → `_scheduleVerified` → strip exemption → canonical plan persistence | Resolver skipped model-complete flights; verify mode missing |
| #106 | Gap 1 (API false-negative → route-only retry) + Gap 2 (times-only backfill) | Cross-carrier times-lift in route-only retry |
| #108 | Cross-carrier times-lift: strict carrier match in route-only retry | Model-complete flights still skipped resolver, strip nulled their numbers |
| #111 | Universal verify mode in `flightNeedsResolve`; all three completion branches write `_scheduleVerified` | FlightCard's inline title code only read `_userSuppliedFlightNumber`, ignored `_scheduleVerified` |
| #114 | Extracted `buildFlightCardTitle`; title precedence now: user-supplied → schedule-verified → autoFlight → carrier-only | Strip and `flightNumberStrip.js` maintained as two copies; no pipeline-to-title integration test |

**2026-07-01 clean-slate audit + follow-up fixes (this session):**

- **PDF confirmed correct:** `renderFlightBlock` at `itineraryPdf.js:1043` reads `fl.flight_number` directly from `data` (applyQualityLayer output). Since the strip's `_scheduleVerified` exemption preserves verified numbers in `data`, the PDF sees them. No fix needed.
- **Strip drift eliminated:** `applyQualityLayer` now imports and calls `applyFlightNumberStrip` from `src/flightNumberStrip.js` instead of inlining a duplicate. Single source of truth; tests and production can't diverge.
- **Pipeline-to-title test added:** `tests/test_title_pipeline.mjs` (20 assertions) tests strip output → `buildFlightCardTitle` → rendered title text. Scenario 1 is the exact EWR-SFO recurrence guard. This is the test that, had it existed earlier, would have caught the PR #114 root cause.

**Still needs user's real-trip visual verification:**
- Build EWR-SFO UA round-trip → confirm all three surfaces agree: Overview card, day-by-day FlightCard title, PDF flight line.
- Build EWR-LAX AA → confirm honest fallback line (not bogus NH times).
- Build Denver UA → happy-path regression check.

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
| 11 | Overview/cards → tabbed view | ✅ Merged + verified live (B-prime: 5 primaries + More ▾ overflow) | #107 |
| 12 | PDF missing flight numbers (+ slow) | ✅ Merged + verified live. PR #83 reverted → #84 canonical plan persistence + strip exemption → #106 gap fixes (times backfill + retry) → #108 cross-carrier strict match → #111 universal verify mode → #114 FlightCard title reads `_scheduleVerified`. 2026-07-01 audit confirmed PDF correct; strip drift eliminated (now imports helper); pipeline-to-title integration test added. Awaiting user's real-trip visual verification (EWR-SFO, EWR-LAX AA, Denver). Perf untouched per instruction. | #84 + #106 + #108 + #111 + #114 |
| 13 | Remove gold; navy + silver palette | ✅ Merged + verified live | #79 |
| 14 | Day-scoped activity count ("1 activity on one day" → 1 every day) | ✅ Merged + verified live | #81 |
| 15 | Toggle: narrate build request vs manual dropdowns | ⬜ Not started | — |
| 16 | Build/narrative button navy-on-navy (invisible) | ✅ Merged + verified live | #86, #87 |
| 17 | In-build caption "2–3 min" vs dynamic estimate | ✅ Merged + verified live | #86 |
| 18 | "2 activities" trip-TOTAL gave 9 (extends #14 to whole-trip) | ✅ Merged + verified live. PR #99 prompt-only fix; PR #112 added deterministic classifier + post-build cap enforcement after user hit the recurrence with "one activity during the entire itinerary" phrasing. | #99 + #112 |
| 19 | Live flight-status panel CORS-blocked | ✅ Merged + verified (proxy 200, no CORS; panel-render not re-tested) | #88 |
| 20 | Outputs-step landed on review picker, not top | ✅ Merged + verified live | #92 |
| 21 | Hotel cards lacked website link | ✅ Merged + verified live | #94 |
| 22 | Expert review "Apply" — reported broken | 🔎 **Open, awaiting user re-test** — reproduced live and Apply DID work (~2.5 min full re-plan); likely the now-fixed invisible buttons (#23) made it feel broken. | — |
| 23 | More navy-on-navy (review findings + tab pills) | ✅ Merged + verified live | #93 |
| 24 | Live-stream stall watchdog + adaptive KV-poll budget | ✅ Merged + verified live | #97 |
| 25 | Narrate-vs-dropdown call-out (intro overlay + wizard step 1) | ⬜ Not started — user flagged 2026-06-30 ~7:38 PM EDT. Partial scope of original #15, focused on discoverability rather than the mode toggle. | — |
| 26 | PDF luxury palette (cover photo hero + color section breaks + activity image thumbnails) | ⬜ Not started — user flagged 2026-06-30 ~7:38 PM EDT. Likely 2 PRs (palette + hero, then image thumbnails). Touches src/pdf/itineraryPdf.js — styling only, not perf. | — |

**TRUE Score: 22 of 26 merged. 4 remaining (#7, #15, #25, #26, plus #22 awaiting re-test). #6 parked.**

The structural recurrence guards are now in place. Two of today's PRs (#111 + #112) established a pattern: any prompt rule the model can pattern-match against now has a deterministic enforcement layer on top. Future similar bugs ("no rental car → model emits one anyway", "vegetarian only → model surfaces a steakhouse") should follow this same belt + suspenders approach.

## 2026-07-07 session — /find LOCATION autocomplete + PDF export

User reported two /find (local-info-only) gaps: (1) "the app has trouble identifying Bolton Landing NY" / "takes too long to surface the town to begin search", (2) no PDF export with live hyperlinks for websites/reservations/phone numbers.

**Root-cause finding (item 1):** Direct `/api/find` probes (3x) confirmed the server-side pipeline handles "Bolton Landing" correctly — the actual gap was that the LOCATION field was a plain text input with zero disambiguation. A bare "Bolton" silently resolved to Bolton, Greater Manchester UK instead of Bolton Landing, NY, and there was no confirmation of what the user meant before the 30-45s search ran.

- **PR #131** (open, awaiting merge) — `feat/find-location-autocomplete`. New `/api/place-autocomplete` endpoint proxies Google Places Autocomplete (New) via the existing `GOOGLE_PLACES_API_KEY`. LOCATION field now shows a debounced dropdown of disambiguated suggestions as the user types, with keyboard nav. Soft-fails to freeform typing on any error. 19 new tests (Bolton Landing vs Bolton UK disambiguation case included).
- **PR #132** (open, awaiting merge) — `feat/find-pdf-export`. New `src/pdf/findPdf.js`, sibling to `itineraryPdf.js` (which now exports its shared cursor/hyperlink primitives). "Save as PDF" button in the /find results row. Live tel:/website/booking/maps hyperlinks throughout, including the Locally Sourced section. 19 new tests verifying embedded link annotations.

Both PRs are independent (branched off master separately, non-overlapping code) and can merge in either order. Both green on all CI checks except the pre-existing Hex-leak baseline failure (confirmed via `git stash` + CI history on master's last 3 commits — **not introduced by either PR**, already broken on master since before this session). That gate will need the user's call: bump the baseline, or fix the underlying hex literals separately.

## Remaining (in user's preferred order)

1. **#25 Narrate-vs-dropdown call-out** — user-facing discoverability. Add a clear card on the first-visit intro overlay (PR #102 surface) AND a persistent radio-style choice at wizard step 1 ("Tell me about the trip" vs "Use dropdowns"). Smaller scope than the full #15 toggle (no underlying mode change, just the call-out).
2. **#26 PDF luxury palette** — user-facing polish. Replace dark-blue + white PDF with destination-aware luxury palette: photo hero on cover, color section breaks, activity image thumbnails. Likely 2 PRs (palette + cover first, image thumbnails second). Touches src/pdf/itineraryPdf.js (styling only — perf still off-limits per user).
3. **#7 Hotel-swap dependency resolution** — touches swap pipeline; design-spec'd, build later.
4. **#15 Narrate vs dropdowns toggle (full)** — largest unknown; touches the build prompt pipeline. The discoverability call-out (#25) covers the visible UX; the full toggle changes mode-aware prompt assembly. Scope separately.
5. **#22 Apply broken** — awaiting user re-test now that #23 invisible-button regressions are well-shipped.
6. **Real-trip live probes**
   - PR #108 carrier-match: build EWR-LAX AA200 and confirm honest fallback rather than wrong-carrier times.
   - PR #111 verify-mode: build EWR-SFO UA round-trip and confirm flight numbers render on screen + PDF.
   - PR #112 activity-count cap: build any trip with "one activity during the entire itinerary" and confirm exactly 1 activity in the final plan.

Parked:
- **#6** — per user 2026-06-30. Don't pick up unless user explicitly asks.
- **Manifest rebrand** — `public/manifest.webmanifest` still says `"name": "Trip Optimizer"` / `"short_name": "Trip"`. Not part of any merged PR. Park until user calls it.

## Expert-review cluster — COMPLETE

Cluster wrapped 2026-06-30 PM. All four sub-items shipped and verified live:
- **#8 part 1** — `ReviewPanel` auto-runs on fresh build (autoRun guarded once per build, mirrors IntroductionAutoGenerator). autoReview = !initialReview. Shipped PR #90.
- **#8 part 2a** — reviewerSourceIds lifted to wizard state (region-aware default); compact picker card in the outputs step; feeds the pre-build `/api/review-retrieve` pass + ReviewPanel (externalSourceIds). Shipped PR #91.
- **#8 part 2b** — apply-mode toggle ("auto" vs "approve_each") in the picker card; auto-apply effect fires `handleApply` with `findingsOverride` once per review; once-per-review `autoApplySigRef` guard; persisted via `apply_mode_choice` in `onReviewChange`. Shipped PR #101. **Default flipped from "auto" to "approve_each" 2026-08-08** (`CLAUDE.md` "KNOWN FAILURE MODE #15") — combined with `autoReview = !initialReview` re-running the review from scratch on every reopen before it persists "done", the "auto" default meant a user who reopened the app mid-cycle silently retriggered a fresh review AND a fresh ~2min full-revision apply, repeatedly, with no confirmation. The toggle itself still lets a user opt into "auto" explicitly. **Same-day follow-up:** the default flip alone didn't help a trip that had already run one review cycle pre-fix — its persisted `apply_mode_choice: "auto"` was read as if it were a real choice, so the loop kept recurring on those trips ("we had this before, why is it back"). Fixed with a new `apply_mode_explicit` flag, set only by an actual toggle click and persisted alongside the choice; old sessions have no such field and now correctly fall back to `approve_each` (`CLAUDE.md` "KNOWN FAILURE MODE #15" follow-up). **Also same day:** both `BuildProgressScreen` and `BuildAndReviewOverlay` gated their Cancel button on `loading` alone even though the overlay itself stays visible through `loading || reviewRunning`, so Cancel vanished exactly when the review/apply phase started; and even when visible, the outer `handleCancel` had no reference to `ReviewPanel`'s own abort controller. Fixed with a `reviewCancelRef` threaded from `TripOptimizer` into `ReviewPanel`, and both overlays' Cancel condition changed to `(loading || reviewRunning)` (`CLAUDE.md` "KNOWN FAILURE MODE #16").
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

**Lesson (added 2026-06-30 PM via PR #108): end-to-end simulation against live API data catches bugs unit tests miss.** PR #106's unit tests all passed; the cross-carrier times-lift bug only surfaced when a production `/api/flights-search` probe for EWR-LAX with `airline=AA` returned 15 rows from other carriers and zero AA rows, then a step-through of the route-only retry showed `pickFromPool` happily picking an NH redeye whose times then merged onto the AA flight. Take-away: after any flight-pipeline change, probe production for at least one happy path, one airline-filter false-negative case, and one true-miss case before declaring done. Scenario E in `tests/test_flight_resolver.mjs` now locks the regression in.

**Coverage status:** Base fix PR #84 + gap fixes PR #106 + carrier-match fix PR #108 together cover (1) model omits everything → API hit → number + times; (2) model emits number only → times-only backfill; (3) airline-filter API miss → route-only retry with strict carrier match; (4) total miss → honest `_timesUnconfirmed` PDF line; (5) route-only retry with NO carrier match in the response → honest fallback instead of cross-carrier times-lift.

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
3. Flight-numbers investigation is closed structurally. **Ask user to run the three visual checks** (EWR-SFO round-trip, EWR-LAX AA, Denver) and confirm all three render surfaces (Overview card, FlightCard title, PDF) agree. If any surface fails, the fix is in that surface's specific code path — the data pipeline is now clean.
4. Resume remaining list in user's preferred order: #7 → #15 → #22 (awaiting user re-test).
5. One focused PR at a time, green CI, verify live after merge. **No code without user "go".**
6. Update this wiki in the same PR that changes meaningful state.

## How to keep this wiki current

- Lives in-repo at `docs/wiki/` — every clone gets it.
- Update wiki files in the same PR that changes the corresponding state.
- Dated work logs under `learnings/YYYY-MM-DD.md`. Persistent facts under `entities/` or `concepts/`.
- Keep `handoff.md` as the single "where are we right now" — rewrite it freely.
