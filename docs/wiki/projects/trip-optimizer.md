# Trip Optimizer

## Overview

Luxury travel-planning web app. Free-text brief → structured day-by-day plan with hotels, restaurants, activities, ground transport, flights, and a generated PDF. Mobile-first. PWA-installable. Hosted on Cloudflare Pages with Pages Functions as the API layer.

- **Repo:** https://github.com/jhwiv/trip-optimizer
- **Live:** https://www.routesmith.ai (also reachable at https://trip-optimizer-6og.pages.dev)
- **Default branch:** `master`
- **Visibility:** Public
- **Status:** Maintenance mode — feature-complete; only targeted tweaks.

## Two surfaces, one bundle

- `/` — `App.jsx` (default export) — wizard build flow
- `/find` — `FindView` (named export) — quick lookup
- Route decision happens in `src/main.jsx` before any component tree mounts, using a regex `/^\/find(\/|\?|$)/`. No client-side router beyond this single branch.

## Current status (as of 2026-06-27, post-#69 merge)

### Open PRs

None.

### Open issues

None on GitHub. See `concepts/known-issues.md` for two non-blocking infra/QA gaps.

### Last action

2026-06-27 14:45 EDT — **PR #69 squash-merged** as `c2bfb45`. Production deploy succeeded. User manually verified at 4:37 PM EDT:
- ✅ No on-screen intro card
- ❌ PDF intro missing (race condition — see `handoff.md`)
- ⚠️ PDF generation slow (pre-existing)

### Active bug — NOT YET FIXED

Race condition: PDF download can be triggered before the post-build `IntroductionAutoGenerator` finishes its `POST /api/introduction` call, so `data.introduction` is empty when the PDF chain reads it. PR #69 isn't broken — the on-screen card it removed used to give an implicit "intro is ready" signal. Now there's no gate.

See `handoff.md` for the diagnosis and proposed fix shape.

### Outstanding infra work

1. Cloudflare Pages Preview environment missing `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, and `JOBS` KV binding. Walkthrough delivered; completion not yet confirmed.
2. Wizard date picker hostile to browser automation (see `concepts/known-issues.md` #2).
3. PDF generation slow on multi-day itineraries (pre-existing).

## Merges on 2026-06-27

- **#69** `fix/intro-pdf-only` — Make trip introduction PDF-only (remove on-screen intro card). Merged 14:45 EDT as `c2bfb45`. Diff `src/App.jsx` +42 / −337.
- **#68** `fix/expert-apply-connection-drop` — Resume surgical Expert-Review apply via KV poll when the live stream drops
- **#67** `feat/auto-introduction` — Auto-generate trip introduction as a separate post-build call
- **#66** `fix/review-replan-load-failed` — Full re-plan aborts mid-stream now surface honest errors, not bare "Load failed"
- **#65** `feat/local-providers` — Local providers (verified drivers, guides, tours, wine tastings) with fetch gating and honest errors
- **#64** `fix/build-hang-output-reset` — Preserve output selections across remounts; bound stalled build stream
