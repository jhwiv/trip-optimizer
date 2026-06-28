# Conventions

## Maintenance mode

The app is **feature-complete**. Only targeted tweaks. Larger architectural changes need explicit approval before work starts.

## Soft-fail everywhere

Missing API keys or KV bindings must return a degraded response, never a 500. Functions should remain usable in partial outages.

## Time format

12-hour AM/PM everywhere — UI **and** model prompts (PR #55).

## Honesty in review/apply

Don't claim un-applied fixes. Professional Review's partial-apply path explicitly distinguishes "applied" vs "would-apply" (PR #54). Stream drops surface honest errors instead of bare "Load failed" (PR #66).

## Testing

- Plain Node test scripts under `tests/`, run by `tests/run-all.mjs`.
- Each file prints `N passed, M failed` on its last line.
- ~1240 tests across 34 suites (as of 2026-06-27).
- CI runs the suite on every PR — hard gate.

## Lint

- ESLint over `src/`.
- Hard gate target. Currently a soft gate while ~14 baseline errors are worked down. Flip to hard gate once baseline is clear.

## PR norms

- Each fix or feature ships as its own branch (`fix/...`, `feat/...`, `chore/...`, `tests/...`).
- PR body includes a "What changed" section and an explicit **Needs live confirmation** checklist for anything CI can't verify (PDF rendering, on-screen behavior).
- CI gates: Unit tests, ESLint, Vite build, Cloudflare Pages preview, Cursor Bugbot.
- Squash-merge via the PR UI; commit history shows merge commits with PR numbers.

## Routing rule

Don't add a client-side router. The single regex branch in `src/main.jsx` is intentional — it keeps hook usage clean and avoids React Router weight. Two surfaces, one bundle.

## PDF intro pattern (post #69)

Trip introduction is **PDF-only**. Generation runs as a headless post-build effect via `/api/introduction`, persisted to `data.introduction`. `applyGeneratedIntroduction(plan, data, { force: false })` keeps the no-clobber guard so recovered/existing intros are never overwritten. PDF chain reads `data.introduction.{arc,differentiators}` in `src/pdf/itineraryPdf.js`.

**Known issue:** nothing currently gates the PDF download button on the headless generation completing. See `handoff.md` and `concepts/known-issues.md`.

## Wiki maintenance

This wiki lives at `docs/wiki/` in the repo. Every meaningful change (PR merged, infra fixed, bug discovered, decision made) should update the relevant wiki page in the same PR. Keep `handoff.md` current as the single-file "where are we right now" snapshot.
