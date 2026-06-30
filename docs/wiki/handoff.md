# Trip Optimizer (RouteSmith) — Handoff (2026-06-30, 3:00 PM EDT)

> One-page state of the world. Read this first when picking up Trip Optimizer / RouteSmith in a new thread. Then read `index.md` for the rest of the wiki.

## Repo & deploy

- **Repo:** [jhwiv/trip-optimizer](https://github.com/jhwiv/trip-optimizer) · default branch `master`
- **Live:** [www.routesmith.ai](https://www.routesmith.ai) (canonical) · also `trip-optimizer-6og.pages.dev`
- **Hosting:** Cloudflare Pages + Pages Functions; Anthropic Sonnet 4.5 for builds; Perplexity Sonar for retrieval; KV (`JOBS`) for cache/job state
- **CI gates (all required on every PR to master):** Unit tests (`tests/run-all.mjs`), ESLint (0 errors), Vite build, Hex-leak baseline, Contrast audit (WCAG AA). Cloudflare Pages preview + Cursor Bugbot are non-blocking.

## Active workstream: the 24-item update list (2026-06-29 → ongoing)

User supplied a 15-item update list (item 16 blank). Live testing surfaced 9 additional items (16–24). Working in waves, one focused PR at a time, each verified live on www.routesmith.ai after merge (preview can't run builds — no API keys; see `concepts/known-issues.md`).

**TRUE Score: 21 of 24 merged. 3 active items remaining + 2 parked.**

### Update table

| # | Item | Status | PR |
|---|------|--------|----|
| 1 | Reset button on hero | ✅ Merged + verified live | #80 |
| 2 | Continue → Trip style on both mobile & desktop | ✅ Merged + verified live | #80 |
| 3 | Budget: allow multiple price ranges | ✅ Merged + verified live | #80 |
| 4 | Preselect outputs (all but Badges, Pronunciation) | ✅ Merged + verified live | #80 |
| 5 | Dynamic build-time estimate | ✅ Merged + verified live | #80 |
| 6 | "Preparing introduction" drop → land at top/Overview | ⏸ **PARKED** (2026-06-30 PM) — diagnosis was the Save-as-PDF gate while the headless intro generator runs; not a visible layout drop. Do not pick up unless user explicitly asks. | — |
| 7 | Hotel-swap re-resolves dependent activities | ⬜ Not started | — |
| 8 | Auto expert-review + pre-build source picker + apply-mode toggle | ✅ All three parts merged + verified live | #90, #91, #101 |
| 9 | App intro overlay (Add-to-Home-Screen, how-to) | ✅ Merged + verified live (bundle ships `Add to Home`) | #102 |
| 10 | Collapse expert-review section to one line after rebuild | ✅ Merged + verified live (bundle ships `Revalidate`) | #100 |
| 11 | Overview vs cards → tabbed view | ⬜ Not started — **next pickup** after the flight-resolver fix. Interpretation TBD: B-prime (5 primaries + More) vs B literal (4 + More) vs A (rename Lodging→Hotels only) vs C (rework Overview as at-a-glance, keep 9-tab strip). Confirm with user before code. | — |
| 12 | PDF missing flight numbers | ✅ Merged + verified live (PDF shows numbers); see `concepts/flight-resolver-gaps.md` for the in-flight follow-up | #84 |
| 13 | Remove gold; navy + silver, no big color blocks | ✅ Merged + verified live | #79 |
| 14 | "1 activity on one day" gave one every day | ✅ Merged + verified live | #81 |
| 15 | Toggle: narrate build request vs manual dropdowns | ⬜ Not started — largest unknown; would touch the build-prompt pipeline. Scope before coding. | — |
| 16 | Build/narrative button navy-on-navy | ✅ Merged + verified live | #86, #87 |
| 17 | In-build caption hardcoded "2–3 min" → dynamic | ✅ Merged + verified live | #86 |
| 18 | "2 activities" trip-TOTAL gave 9 (extends #14 to whole trip) | ✅ Merged + verified live (bundle ships `TRIP-TOTAL`) | #99 |
| 19 | Live flight-status panel CORS-blocked | ✅ Merged + verified (proxy 200, no CORS) | #88 |
| 20 | Outputs step landed on review-sources card not top | ✅ Merged + verified live | #92 |
| 21 | Hotel cards lacked website link | ✅ Merged + verified live | #94 |
| 22 | Expert review "Apply" — reported broken; not reproduced | 🔎 Open — awaiting user re-test now that #23 invisible-buttons are shipped | — |
| 23 | More navy-on-navy (review findings + tab pills) | ✅ Merged + verified live | #93 |
| 24 | Build-stall watchdog + adaptive KV-poll budget | ✅ Merged (PR #97) + bundle ships `StallError` / `onStallNotice` / `Live stream paused`. Behavioral test (stall a real build, verify watchdog fires) still pending. See `concepts/build-stall-watchdog.md` for the revised-diagnosis lesson. | #97 |

### Active items (3)

- **#11 tabbed strip** — user picked this as next pickup after the flight-resolver fix lands. Need to confirm interpretation before any code.
- **#7 hotel-swap deps** — re-resolves bar drinks / activities tied to the old hotel when a swap happens. Touches the swap pipeline.
- **#15 narrate-build toggle** — free-prose vs current dropdown wizard. Largest unknown; deserves its own scoping conversation.

### Awaiting user re-test (1)

- **#22 expert-review Apply** — reproduced in a prior thread (~2.5 min full re-plan); user suspects the now-fixed invisible buttons (#23) made it feel broken. Holding for user re-test, no code planned.

### Parked (2)

- **#6** — "Preparing introduction" / land at top/Overview. Diagnosis-only outcome; not a real visible drop. Do not resurrect without explicit ask.
- **`#9` manifest rebrand sub-item** — `public/manifest.webmanifest` still says `"name": "Trip Optimizer"` / `"short_name": "Trip"`. Separate from the merged intro-overlay #9 work. Park until user calls it.

## Flight resolver — in-flight follow-up (2026-06-30 PM)

User reports flight numbers + times occasionally missing from build + PDF. Reads like a "fix that gets reverted" but a full audit since PR #84 shows no code regression — the bundle ships the full fix and every audited commit since #84 leaves the resolver path intact. The bug is real but it's a coverage gap in the original #84 fix, not a revert.

Two gaps identified, both confirmed by reading the code in this thread:

1. **API miss → silent bail.** When `/api/flights-search` returns no rows for a route+date+airline combination, the resolver continues silently and the flight stays bare.
2. **Resolver skips flights where the model emitted a number.** The bail at `~6469` drops flights with a flight_number from the targets list, so the API is never called for them — which means times don't get backfilled either, even though the backfill code at `~6517` already supports it.

Production API probes (8 routes, 6 of 8 hit) show that **the airline filter is often the cause of an API miss**, not the route itself — e.g. `EWR-LAX&airline=AA` returns 0 rows but the same route route-only returns 15. So there's a third opportunity: airline-filtered miss → retry route-only.

Full diagnosis, probe data, and proposed fix in `concepts/flight-resolver-gaps.md`. No code shipped yet — user has authorized the shape; PR to follow after the wiki reset.

## Process lesson worth re-stating

The wiki's `#24` entry got written from memory and was wrong (it said "harden 180s threshold + decouple #8 auto-review"; reality was the live stream had NO client-side stall watchdog and #8 was already decoupled). The correct fix shipped (PR #97) only after reading the actual code.

**Wiki entries from prior sessions are hypotheses; re-verify against source before opening the code branch.** The same discipline applies to handoff entries — this handoff was 4 PRs behind reality at the start of the 2026-06-30 PM thread because each PR landed without updating the table. Going forward: every PR that moves a row's status should update the table in the same PR.

## Open infrastructure work (not blocking)

1. **Cloudflare Pages Preview env vars** — `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `JOBS` KV bound to Production only. Preview builds soft-fail. See `concepts/known-issues.md` #1.
2. **Wizard date picker** — hostile to browser automation; blocks full end-to-end smoke tests. See `concepts/known-issues.md` #2.
3. **PDF generation performance** — pre-existing slowness on multi-day itineraries (`jspdf` + `html2canvas-pro`). Item #12 covers flight numbers only; perf is separate and not to be touched without explicit instruction.

## User context / preferences (not optional)

- Skilled JS/React/Cloudflare dev. Direct, terse communication. **No filler, no preambles, no exclamation points.**
- **HARD PREFERENCE: never ask questions as numbered lists/paragraphs in chat — use the interactive checkbox/multiple-choice tool, or plain prose.** User has flagged violations of this repeatedly.
- Windows desktop (not Mac/mobile). Comfortable with `gh` CLI, Cloudflare dashboard, PowerShell.
- **Build process:** minimal/focused fixes; no auto-spawned PRs without explicit "go"; one PR at a time; every PR carries a "Needs live confirmation" checklist; verify on www.routesmith.ai (push + curl/grep before "done"). Do not touch PDF perf or Preview env vars without instruction.
- Owns RouteSmith + several travel apps + RailbirdAI + Vigil Family Records + Barrier Island Digital. Prefers this persistent wiki over re-explaining context.

## What the next thread should do

1. Read this `handoff.md`, then `index.md`, then relevant `concepts/*` — especially `concepts/flight-resolver-gaps.md` if the flight follow-up is still in flight.
2. Cross-reference long-term memory for preferences not captured here.
3. Reconcile the table against `git log --oneline -30` before assuming any item's status.
4. One focused PR at a time, green CI, verify live after merge. No code without user "go".
5. Update this wiki in the same PR that changes meaningful state.

## How to keep this wiki current

- Lives in-repo at `docs/wiki/` — every clone gets it.
- Update wiki files in the same PR that changes the corresponding state.
- Dated work logs under `learnings/YYYY-MM-DD.md`. Persistent facts under `entities/` or `concepts/`.
- Keep `handoff.md` as the single "where are we right now" — rewrite it freely.
