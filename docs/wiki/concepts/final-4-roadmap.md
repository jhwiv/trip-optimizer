# RouteSmith.ai — Final 4 Roadmap Brief

**Author:** Computer session 2026-06-30, end-of-day
**Source-of-truth wiki:** `docs/wiki/handoff.md` on master (jhwiv/trip-optimizer · commit `a984237`)
**Live:** [www.routesmith.ai](https://www.routesmith.ai) · index bundle `assets/index-2-vNTVcg.js`
**Score at this brief:** 22 of 24 merged + verified live. The four items below are the entire remainder.

---

## TL;DR — what's actually left

| # | Item | Status | Effort | Risk | Suggested order |
|---|------|--------|--------|------|------------------|
| 22 | Expert-review "Apply" — reported broken | 🔎 Awaiting real-trip re-test by user | Low (likely already fixed indirectly by #23) | Low | **1st** |
| 6  | "Preparing introduction…" / land at Overview | ⚪ Parked 2026-06-30 (diagnosis revision: only the Save-as-PDF gate string is that label; no visible layout drop) | Low if revived | Low | **2nd** (validation only — confirms park decision) |
| 7  | Hotel-swap re-resolves dependent activities | ⬜ Not started; design-spec'd | Medium | Medium (touches swap pipeline + canonical plan persistence) | **3rd** |
| 15 | Narrate vs dropdowns toggle | ⬜ Not started; largest unknown | Medium–High (touches build-prompt pipeline) | Medium | **4th** |

Rationale for the order: #22 and #6 are validation work (test scenarios, no new code expected) and can be cleared in a single session. #7 is the next clear engineering win because the design is already sketched. #15 is intentionally last because it changes the front door of the wizard and deserves a proper experiment rather than a guess.

---

## Item #22 — Expert-review "Apply" reported broken

### Status (verbatim from handoff.md row)

> Open, awaiting user re-test — reproduced live and Apply DID work (~2.5 min full re-plan); likely the now-fixed invisible buttons (#23) made it feel broken.

### Hypothesis

The user-reported "Apply is broken" surfaced before PR #93 fixed the navy-on-navy invisible-button regressions in the review-findings UI. In the previous session's live repro, Apply itself completed (full re-plan in ~2.5 min and findings flipped to applied), but the button that fires it was visually invisible against the panel background, so it felt like nothing happened. Since #93 + #101 (apply-mode toggle / auto-apply default) shipped, this should now be unblocked.

### Code anchors (current master)

- `src/App.jsx:5481` — `handleApply({ findingsOverride, forceMode })` entry point
- `src/App.jsx:5258–5269` — `applyModeChoice` state (`auto` default vs `approve_each`), persisted via `apply_mode_choice` on `onReviewChange`
- `src/App.jsx:5561–5612` — partial-apply path: appliedFindings vs unappliedFindings, surfaced via `setNotice(...)` with the "Re-plan to apply the rest" message
- `src/App.jsx:5521` — `buildRevisionSystemPromptSurgical` (single-finding edits)
- `src/App.jsx:5529` — `buildRevisionSystemPromptFull` (multi-finding re-plan)

### Test scenarios to close #22

Run each on **www.routesmith.ai**. No code changes expected unless one fails.

**Scenario A — Auto-apply happy path**
1. Build a 4-day Denver UA trip with the default narrative
2. Wait for the build to complete and the expert-review section to auto-populate (PR #90 behavior)
3. With apply-mode left at default (`auto`), watch for the auto-apply effect to fire once findings land
4. Expected: changelog renders, applied findings flip state, review section auto-collapses to one-line summary (PR #100)
5. Pass criteria: no manual button click required; collapse happens within ~3 minutes of build completion

**Scenario B — Approve-each manual path**
1. Repeat Scenario A but toggle apply-mode to `approve_each` in the picker card before the build completes
2. After findings land, manually select a subset (e.g. 2 of 4 findings) and click Apply
3. Expected: re-plan fires for only the selected findings; remaining findings stay highlighted with the "Re-plan to apply the rest" affordance
4. Pass criteria: Apply button is **visible** (the original #22 symptom), the partial-apply notice renders correctly per `App.jsx:5612`, and re-plan completes in ≤ 3 minutes

**Scenario C — Apply-everything from scratch**
1. Build the same trip
2. In `approve_each` mode, hit "Apply all" (select all checkboxes)
3. Expected: full re-plan via `buildRevisionSystemPromptFull` path, review collapses on success

**Scenario D — Restored saved trip**
1. Build a trip, let auto-apply complete, save the trip
2. Reload the page, restore the saved trip
3. Expected: the collapsed one-line summary persists per `initialReview?.apply_mode_choice` carrying forward (App.jsx:5269)

### Close conditions

- **Close as fixed-by-#23/#101** if all four scenarios pass with the buttons visible and Apply completing.
- **Re-open with new diagnosis** if any scenario reproduces an actual functional break — in that case the brief becomes: file the failing scenario, capture the network trace from `/api/build-revision-surgical` or `/api/build-revision-full`, and route to a real fix PR.

### Estimated effort

15–30 minutes of live testing on the user's side. Zero engineering hours unless a scenario fails.

---

## Item #6 — "Preparing introduction…" / land at Overview

### Status (verbatim)

> Parked by user 2026-06-30 (diagnosis: only on-screen "Preparing introduction…" string is the Save-as-PDF gate while the headless intro generator runs; not a visible layout drop). Don't pick up unless user revisits.

### Why it's parked

The wiki entry for #6 originally said: "kill the preparing-introduction drop on completion; land at top/Overview; surface findings." When the actual code was read (`App.jsx:3674–3682` and `App.jsx:6707–6782`), it became clear there is **no visible layout drop**. The only place the string "Preparing introduction…" appears is the disabled state on the Save-as-PDF button while `IntroductionAutoGenerator` is mid-fetch — that's intentional and prevents PR #69's race where the PDF would generate without the intro paragraph. The original report likely conflated this with something else (possibly the build-stall watchdog issue, which became #24 and shipped via PR #97).

### Code anchors

- `src/App.jsx:3674–3682` — the PDF download gate logic via `isPdfDownloadReady({ plan, isGenerating: introIsGenerating })`. This is the **only** consumer of the "Preparing introduction…" string in the rendered UI.
- `src/App.jsx:6707` — `IntroductionAutoGenerator` component; the headless intro fetch.
- `src/App.jsx:6759` — the `setState` race-closure for the generating flag (the actual subtle bug that PR #69 closed; #6's wiki entry may have been an artifact of memory of that fix).

### Validation scenarios (only if #6 is revived)

Two cheap tests can confirm the park decision is correct:

**Scenario A — Visual scroll check**
1. Build a 4-day trip on www.routesmith.ai
2. Watch the build complete and the post-build view render
3. Expected: view renders with the hero/Overview tab active (PR #92 + #107 behavior); no visible "Preparing introduction…" overlay or layout shift in the main content
4. Pass criteria: only the Save-as-PDF button shows the "Preparing introduction…" label, and only for the ~5–20 second window while the intro generator finishes

**Scenario B — DOM grep**
1. After Scenario A renders, open DevTools and run `document.body.innerText.match(/Preparing introduction/gi)`
2. Expected: returns **null** until you scroll/look at the Save-as-PDF button, OR returns exactly one match located inside the disabled button element

### Close conditions

- **Confirm parked** if both scenarios behave as predicted. Update the wiki entry to state "validated 2026-MM-DD as not a real bug."
- **Un-park** only if Scenario A shows a visible content layout shift on build completion or the string appears outside the PDF button.

### Estimated effort

10 minutes of live testing. No code unless un-parked.

---

## Item #7 — Hotel-swap re-resolves dependent activities

### Status

Not started. Design-spec'd but no PR yet.

### Problem statement

The post-build screen lets the user swap out a hotel via the existing `FindAnotherControl` flow (`App.jsx:1918+`). When a hotel is swapped, the rest of the day-by-day plan currently does **not** re-evaluate. If the new hotel is on the opposite side of the destination, walking-distance dining/activity picks that were tied to the original hotel's neighborhood become wrong (a 5-minute walk turns into a 30-minute taxi).

### What "re-resolves dependent activities" needs to do

- Detect that a hotel swap changed the locality/neighborhood (compare `swapAlternatives.js`'s `resolveLegCity` output before and after)
- Walk the canonical plan's days and flag any activity/dining card whose original distance assumption is now violated
- Offer the user a "Re-plan dependent activities" affordance (don't auto-rewrite — the user's preference is explicit approval per the apply-mode pattern from #8 part 2b)
- On accept, fire a scoped re-plan (smaller than full re-plan; reuse the surgical-revision system prompt at `App.jsx:5521`)

### Technical dependencies

1. **Locality delta detection** — `src/swapAlternatives.js` exports `resolveLegCity()`. Need a sibling helper `localityDelta(prevHotel, nextHotel)` that returns either `"same"`, `"adjacent"`, or `"different"` based on city/neighborhood comparison. Reuse the `geo_sanity` checks in `tests/test_geo_sanity.mjs` patterns.

2. **Distance-violation scan** — for each activity/dining card on each day, the original plan already carries `_legCity` metadata. After a swap, scan days where `it.legCity === oldHotelCity` and the new hotel is in a different city. The scan must also respect activities that were explicitly user-pinned (look for `_userPinned` or similar flags — confirm by grep before coding).

3. **Surgical revision prompt extension** — `buildRevisionSystemPromptSurgical` (`App.jsx:5521`) currently revises based on findings IDs. Need to extend the input to accept a `swapContext: { changedHotel, affectedSlots: [...] }` payload so the model knows which slots to re-pick without re-planning the entire trip.

4. **Persistence** — same `onPlanRevised` canonical-plan pattern that flight-resolver PRs #84/#106/#108 use. Do **not** mutate the rendered copy; persist to `rawData` and let `applyQualityLayer` re-derive. This pattern is the durable lesson from #12's PR #83 vs PR #84 reversal.

5. **UI affordance** — extend the swap modal or the post-build banner to surface the affected-slots count and a "Re-plan these N slots" CTA. Keep the apply-mode (auto vs approve-each) preference from #8 part 2b honored — same toggle, no new UX surface.

### Required new test coverage

- `tests/test_swap_alternatives.mjs` already covers basic swap selection. Add:
  - `localityDelta` returns correct value for same-city / adjacent-neighborhood / different-city swaps
  - `affectedSlots` scan correctly identifies activities tied to the original hotel's locality
  - Pinned-by-user slots are exempted from the scan
- New `tests/test_hotel_swap_cascade.mjs`:
  - End-to-end: swap a Santa Fe hotel from one plaza-adjacent property to one 30 minutes out → affectedSlots includes the walking-distance dining card, does NOT include the museum 25 min away by car
  - Re-plan payload sent to surgical-revision endpoint includes the swap context, not just findings

### Code anchors to read first

- `src/swapAlternatives.js` (full file) — current swap pipeline
- `src/App.jsx:1918–1960` — `FindAnotherControl` component
- `src/App.jsx:5481–5612` — `handleApply` and the surgical/full revision paths
- `tests/test_swap_alternatives.mjs` — existing swap test patterns
- `docs/wiki/concepts/architecture.md` — canonical plan persistence model

### Open design questions for the user

1. **Auto-trigger or manual?** When a hotel swap changes locality, should the dependent-activities scan fire automatically and surface affected slots as a banner, or should the user click a separate "Check dependent activities" button after the swap completes?
2. **Re-plan scope ceiling.** If the scan finds many affected slots (say, more than 4), is this still a "scoped surgical revision" or should it escalate to a full re-plan? Setting a sensible ceiling now prevents an unbounded `affectedSlots` payload.
3. **Distance threshold.** What walking-distance threshold counts as "dependent"? The trip-app-builder skill's 10-minute walking rule is a good default, but a hotel-shopping user moving to a property 12 minutes out should probably not trigger the scan. Suggest 15 minutes walking OR 5 minutes driving — confirm.

### Estimated effort

Two PRs:

- **PR-A** — pure helpers: `localityDelta`, `findAffectedSlots`, scan unit tests. ~1 hour build, ~30 minutes review.
- **PR-B** — wire-up: React integration, surgical-revision prompt extension, end-to-end test, live verification. ~1.5–2 hours build, ~30–60 minutes live verification.

Total: half a development session, including the live probes.

---

## Item #15 — Narrate vs dropdowns toggle

### Status

Not started. Largest unknown on the list.

### What the original wiki entry meant

The wizard today asks the user to fill structured dropdowns (destination, dates, travelers, budget tier, interest tags, dining preferences, activity types) AND offers a free-form "Trip narrative" box (`App.jsx:7280+`). The build prompt currently merges both — the narrative is treated as overriding guidelines on top of the dropdowns. The #15 ask is: let the user choose a mode. Either "narrate the trip" (mostly natural language with minimal structured inputs) OR "use dropdowns" (no narrative box). The hypothesis is that letting a confident user just write a paragraph produces better itineraries faster, and forcing a hesitant user through structured dropdowns produces more predictable ones.

### Why this is the largest unknown

Three reasons:

1. **No baseline measurement** — there's no per-input-mode build-quality metric in place today. We don't know whether narrate-mode builds are actually better, worse, or just different.
2. **Prompt-pipeline blast radius** — the build prompt assembly currently weaves `inputs.narrative` and `inputs.guidelines` into multiple system prompts (`App.jsx:2732`, `2820`, `2903`, `9521`, `9587`, `9640`). A mode toggle that nukes the structured inputs in narrate-mode would force re-deriving the constraints the dropdowns currently provide for free (e.g. budget tier feeds the dining-tier filter).
3. **UX risk** — wizards that ask "pick a mode" upfront frequently produce worse engagement than wizards with one clear path. Switching modes mid-build is also a known footgun.

### Proposed experiment design

Treat #15 as an A/B-style experiment, not a one-shot ship.

**Phase 1 — Baseline instrumentation (no user-facing change)**
- Add a `_inputMode` field to the build payload that is auto-classified: `narrate` if `inputs.narrative.length > 200 chars`, `dropdowns` otherwise. Capture this in the build's KV record alongside existing timing data.
- Run for 2 weeks of real builds (the user's own + any shared links). Pull build counts and qualitative-quality flags (did the user accept the build, did they swap many items, did expert-review find many issues?) per mode.
- Deliverable: a one-page report on whether narrate-mode builds today already differ in measurable ways (acceptance rate, swap rate, review-finding count per build) from dropdowns-mode builds.

**Phase 2 — Hypothesis confirmation**
- If Phase 1 shows narrate-mode is materially better (say, ≥30% fewer expert-review findings or ≥30% lower swap rate), ship the mode toggle and default to narrate.
- If Phase 1 shows no material difference, ship a milder change: keep both inputs but reorder the wizard so the narrative box is the **first** step and dropdowns become "Fine-tune (optional)" — let users escape the structured flow without removing it.
- If Phase 1 shows narrate-mode is worse (real possibility — natural language is lossy), close #15 as a milder UX cleanup only: improve the narrative box's prompting and stop. No toggle ships.

**Phase 3 — Implementation (only if Phase 2 says ship the toggle)**
- Mode-aware wizard surface: a single radio at step 1 — "Tell me about the trip" vs "Build from dropdowns". Persist in `localStorage` so a returning user lands in their preferred mode.
- Mode-aware build-prompt assembly: extract the dropdown→guideline derivations (`App.jsx` ~2732, 2820, 2903) into a pure helper `derivedGuidelinesFromInputs(inputs)`. In dropdowns-mode the build prompt uses derived guidelines + (optional) narrative; in narrate-mode it uses narrative + a minimal scaffold (destination + dates + travelers only).
- Telemetry: keep the Phase 1 `_inputMode` flag so post-launch we can monitor whether the chosen default holds up.

### Code anchors to read first

- `src/App.jsx:7280+` — current narrative-box component
- `src/App.jsx:3974` — wizard input destructuring (the shape of `inputs`)
- `src/App.jsx:2732`, `2820`, `2903` — narrative + guidelines blob construction inside build helpers
- `src/App.jsx:9521`, `9587`, `9640` — narrative + guidelines being woven into review/revision system prompts
- `tests/test_introduction.mjs` and `tests/test_v3.mjs` — existing input-shape coverage to extend

### Open design questions for the user

1. **Are you willing to wait 2 weeks for Phase 1 data, or do you want to skip straight to Phase 3?** A skip-straight approach is fine but it locks in a guess about which mode is better.
2. **Do you want mode-switching mid-wizard, or is a one-shot pick at step 1 enough?** Mid-wizard switching is a UX footgun; recommend against.
3. **What counts as "narrate"?** Just the free-form box, or also voice-dictation (the existing dictation affordance at `App.jsx:6396` is wired to the same input field — narrate-mode could surface dictation more prominently).

### Estimated effort

- Phase 1: ~1 hour build (instrumentation + report scaffold), then passive 2-week capture
- Phase 2: report read + 30-minute decision
- Phase 3 (only if shipped): ~3 hours build across 2 PRs (helper extraction + wizard UI), ~45 minutes live verification

Total: depends entirely on whether you want to gather data or guess. Lowest-risk path is Phase 1 → 2 → 3. Highest-velocity path is to skip to Phase 3 with narrate as default and revisit if the data later disagrees.

---

## Execution checklist (when you start back up)

A clean, ordered to-do for the next session:

1. **#22 close-out** — Run Scenarios A–D on www.routesmith.ai. If all pass, update `docs/wiki/handoff.md` row 22 to "Closed by #93/#101; validated 2026-MM-DD." 1 PR, docs-only.
2. **#6 validation** — Run Scenarios A–B. If both confirm parked decision, update the wiki row with a "validated parked" line. 1 PR, docs-only.
3. **#7 PR-A** — Pure helpers (`localityDelta`, `findAffectedSlots`) + unit tests. Open as a focused PR; no UI yet. Get user "go" before PR-B.
4. **#7 PR-B** — Wire-up + surgical-revision prompt extension + end-to-end test + live probe (Santa Fe hotel swap scenario). User "go" before opening.
5. **#15 Phase 1** — Instrument `_inputMode` capture only. No user-facing change. Run 2 weeks then read the report.
6. **#15 Phase 2/3** — Branch on the Phase 1 data. Likely 1 PR for prompt-helper extraction + 1 PR for the wizard UI if shipping.

After all six steps: score is 24 of 24, plus the #15 experiment has shipped data-driven (not guessed).

---

## Live-confirmation discipline (carries from today's lessons)

Every PR in this plan must:

- Be focused: one item, one PR. No bundling.
- Wait for explicit "go" from user before push. The morning's two parallel-thread incident (`PR #104` superseded by `PR #105`) is the recent example of why.
- Carry a "Needs live confirmation" checklist with a real-trip scenario (the AA200 / Denver UA / JAC-FLG pattern from the flight-resolver work).
- Have a bundle-string regression-guard grep on www.routesmith.ai after merge, including signatures for every prior PR that touched the same surface.

These are not new rules — they're the rules that produced today's 22-of-24 result without a regression.

---

## Reference links

- Repo: https://github.com/jhwiv/trip-optimizer
- Live: https://www.routesmith.ai
- Today's closing wiki: https://github.com/jhwiv/trip-optimizer/blob/master/docs/wiki/handoff.md
- Today's learnings: https://github.com/jhwiv/trip-optimizer/blob/master/docs/wiki/learnings/2026-06-30.md
- Today's merged PRs: #96, #97, #98, #99, #100, #101, #102, #103, #105, #106, #107, #108, #109
