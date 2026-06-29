# Trip Optimizer — Handoff (2026-06-27, 4:44 PM EDT)

> One-page state of the world. Read this first when picking up Trip Optimizer in a new thread. Then read `index.md` for the rest of the wiki.

## Repo & deploy

- **Repo:** [jhwiv/trip-optimizer](https://github.com/jhwiv/trip-optimizer) · default branch `master`
- **Live:** [www.routesmith.ai](https://www.routesmith.ai) (canonical; also reachable at [trip-optimizer-6og.pages.dev](https://trip-optimizer-6og.pages.dev))
- **Hosting:** Cloudflare Pages + Pages Functions; Anthropic Sonnet 4.5 for builds; Perplexity Sonar for retrieval; KV (`JOBS`) for cache and job state
- **Mode:** Maintenance / feature-complete

## What shipped on 2026-06-27

Six PRs merged to master, all squash-merged with green CI:

| # | Branch | What it does |
|---|---|---|
| #64 | `fix/build-hang-output-reset` | Preserve output selections across remounts; bound stalled build stream |
| #65 | `feat/local-providers` | Verified local providers (drivers, guides, tours, tastings) with fetch gating |
| #66 | `fix/review-replan-load-failed` | Full re-plan aborts surface honest errors instead of "Load failed" |
| #67 | `feat/auto-introduction` | Auto-generate trip introduction via post-build `/api/introduction` call |
| #68 | `fix/expert-apply-connection-drop` | Resume surgical Expert-Review apply via KV poll when SSE drops |
| **#69** | **`fix/intro-pdf-only`** | **Remove on-screen intro card; keep headless generator for PDF intro** (merged as `c2bfb45` at 14:45 EDT) |

Open PRs: **0**. Open issues: **0**.

## Verified status (production)

User confirmed on www.routesmith.ai after the PR #69 deploy:

- ✅ **On-screen intro is gone** (the PR #69 contract worked)
- ❌ **PDF intro is missing** — the post-build `/api/introduction` call hadn't completed before user clicked Download PDF
- ⚠️ **PDF generation was slow** — pre-existing `jspdf` + `html2canvas-pro` performance on multi-day luxury itineraries, NOT a #69 regression

User wasn't watching the Network tab, so no direct evidence that `/api/introduction` fires — but on-screen check passing + intro-missing-from-PDF + clicked-Download-immediately strongly points to a race condition, not a regression.

## The active bug — race condition (NOT YET FIXED)

**Symptom:** PDF renders with empty intro section when user clicks Download PDF immediately after Day 1 cards appear.

**Suspected cause:** `IntroductionAutoGenerator` (headless component in `src/App.jsx:6088`) fires `POST /api/introduction` in a `useEffect` after the build completes. Nothing gates the PDF download button on `data.introduction` being populated.

```
build completes
  ↓
day cards render  ────────────────▶  user clicks Download PDF
  ↓                                       ↓
POST /api/introduction (5-15 s)      PDF renders without intro
  ↓
applyGeneratedIntroduction → onPlanRevised(next)
  ↓
data.introduction populated (too late)
```

**Why this is consistent with the evidence:**
- PR #67 added the auto-generator
- PR #69 removed the on-screen card that previously gave the user a visible "introduction is ready" signal
- Combined effect: no UI feedback that intro is in flight, no gate on PDF export
- Other PRs touched 2026-06-27 (#64, #65, #66, #68) don't touch the introduction flow

**Proposed fix shape** (started, then abandoned per user direction to reset):
- Expose `isGenerating` from `IntroductionAutoGenerator` via a new `onGeneratingChange` prop, lift it to `ItineraryView`, disable the PDF download button (with "Preparing introduction…" label) until `data.introduction` is populated or the generator finishes/errors

This is the cleanest path — small, surgical, no PDF code changes, no API changes. A local branch `fix/intro-race-on-pdf-download` was started but **never pushed** (sandbox was reset; branch is gone).

## Open infrastructure work (not blocking, but worth doing)

1. **Cloudflare Pages Preview env vars** — `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, and the `JOBS` KV binding are bound to Production only. Preview deploys for PRs return "Server missing `ANTHROPIC_API_KEY`" the moment the user hits Build. Walkthrough was delivered to user; completion not yet confirmed. Until fixed, PR preview verification is impossible for any flow that hits the LLM APIs. See `concepts/known-issues.md` #1.

2. **Wizard date picker** — hostile to browser automation. Not a user-facing bug; blocks any future end-to-end smoke test. See `concepts/known-issues.md` #2.

3. **PDF generation performance** — pre-existing slowness on multi-day luxury itineraries. Worth a `perf/` issue but not urgent.

## User context / preferences (read this — it's not optional)

- Skilled JavaScript/React/Cloudflare developer. Wants direct, terse communication. **No filler.** No "Here's what I'll do" preambles. No exclamation points.
- **Multi-part diagnostic questions MUST be presented as interactive checkbox/multiple-choice (the `ask_user_question` tool), NOT as numbered lists in chat.** This is a hard preference; respect it.
- Working from Windows desktop (not mobile, not Mac). DevTools instructions should match that platform.
- Comfortable with `gh` CLI, Cloudflare dashboard, PowerShell.
- Owns Trip Optimizer + several other travel apps + RailbirdAI + Vigil Family Records + Barrier Island Digital.
- Strongly prefers structured, persistent project documentation (this wiki) over re-explaining context every session.

## What I recommend next thread does

1. Read this `handoff.md`, then `index.md`, then any concepts/* files relevant to the immediate task
2. Cross-reference long-term memory for any user preferences not captured here
3. Confirm orientation with the user briefly, then wait for go-ahead before writing code
4. When green-lit: ship the smallest possible race-condition fix per the proposed shape above
5. Update this wiki as part of any PR that changes meaningful state (merged PR, infra fixed, bug discovered, decision made)

## How to keep this wiki current

- The wiki lives in the repo at `docs/wiki/` — every clone gets it automatically
- Update wiki files in the same PR that changes the corresponding state
- For ongoing work logs, add a dated file under `learnings/YYYY-MM-DD.md`
- For new persistent facts about the project, add or update an `entities/` or `concepts/` page
- Keep `handoff.md` updated as a single-file "where are we right now" — rewrite it freely
