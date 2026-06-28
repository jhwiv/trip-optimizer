# PR Verification Workflow

How to live-verify a Trip Optimizer PR. CI alone is not sufficient for changes that touch UI, PDF, or end-to-end build flow — many things CI cannot see.

## CI gates (automated, always)

Every PR runs:
- **Unit tests** — `npm test` (hard gate)
- **ESLint** — `npm run lint` (currently soft gate)
- **Vite build** — `npm run build` (hard gate)
- **Cloudflare Pages** — deploys the static bundle to a preview URL
- **Cursor Bugbot** — automated code review

CI cannot verify: PDF rendering, on-screen DOM presence/absence, end-to-end build streams, API integration with real keys, runtime behavior of any kind. CI's "Cloudflare Pages" check is only that the static bundle deployed — not that the app works.

## Manual verification (required for non-trivial PRs)

Every PR body should include a **Needs live confirmation** checklist for anything CI can't verify. Standard pattern: a few checkboxes describing the user-visible behavior to confirm.

### Where to verify

**Preferred: preview deploy URL.** Comment on the PR by `cloudflare-workers-and-pages[bot]` includes:
- Commit preview: `https://<short-sha>.trip-optimizer-6og.pages.dev`
- Branch preview: `https://<branch-name>.trip-optimizer-6og.pages.dev`

> **Blocker (as of 2026-06-27):** Preview deploys currently fail at the build step with "Server missing `ANTHROPIC_API_KEY`" — Cloudflare Pages env vars are bound to Production only. See `concepts/known-issues.md` #1. Until fixed, preview-level verification is impossible for any flow that hits the LLM APIs.

**Fallback while preview is broken: production verify post-merge.** Merge on green CI, let Cloudflare deploy `www.routesmith.ai`, run the checklist there. If anything fails, revert the merge commit.

**Local fallback (full Pages Functions):**
```bash
npm run build
npx wrangler pages dev dist --kv JOBS
# wrangler pages secret put ANTHROPIC_API_KEY
# wrangler pages secret put PERPLEXITY_API_KEY
```

`npm run dev` alone (Vite-only) does NOT run Pages Functions — fine for pure-UI changes, not for API-touching changes.

### Standard verification flow

1. Open the verification URL (preview / production / local).
2. Confirm Build mode is selected (not `/find`).
3. Run the wizard with any valid inputs. Don't fight the date picker — defaults are fine.
4. Wait for the results view to render. Look for day-by-day day cards.
5. Run the PR-specific checklist items.
6. Click Download PDF. Wait for `data.introduction` to populate before clicking (currently no UI gate — see active bug). Verify the PDF renders without freezing and contains the expected sections.
7. Spot-check any feature the PR explicitly affects.

## Browser automation lessons (2026-06-27)

- Don't attempt the wizard date picker programmatically until issue #2 in `known-issues.md` is fixed. Accept defaults instead.
- Always set a hard timeout on the build wait (10–12 min) and the PDF wait (4 min) — runaway loops are worse than honest failures.
- A truthful "UNVERIFIED" is more valuable than a fabricated "PASS". If automation can't reach the verification step, say so and recommend a manual pass.

## Honest reporting template

When reporting verification results (automated or manual):

```
Build: COMPLETED / FAILED / TIMED OUT — [brief note, duration]
On-screen check: PASS / FAIL / UNVERIFIED — [evidence]
PDF download: TRIGGERED / FAILED / TAB HUNG — [duration]
PDF check: PASS / FAIL / UNVERIFIED — [evidence]
Merge recommendation: READY / BLOCKED / INCONCLUSIVE — [reason]
```

UNVERIFIED is a legitimate outcome. Don't paper over it.
