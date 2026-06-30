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
- `concepts/build-stall-watchdog.md` — #24 diagnosis: 180s stall watchdog + KV-poll resume + decouple #8 auto-review
- `learnings/2026-06-27.md` — full work log for the day PRs #64–#69 shipped
- `learnings/2026-06-30.md` — work log for the day PRs #96–#102 shipped; #6 parked; flight-numbers investigation opened
