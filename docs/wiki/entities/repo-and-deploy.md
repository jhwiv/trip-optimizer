# Repo & Deploy

## Repo

- **URL:** https://github.com/jhwiv/trip-optimizer
- **Default branch:** `master`
- **Visibility:** Public
- **Owner:** jhwiv

## Hosting / Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite |
| Hosting | Cloudflare Pages |
| API | Cloudflare Pages Functions (`functions/api/*.js`) |
| LLM (builds, reviews, edits, menus) | Anthropic Claude Sonnet 4.5 |
| Retrieval (local-knowledge, booking confirmation) | Perplexity Sonar |
| Cache | Cloudflare KV (binding name: `JOBS`) |
| PWA | Service worker — network-first HTML, cache-first hashed assets |

No backend server beyond Pages Functions. No build step beyond `vite build`.

## Production URL

- **Canonical:** https://www.routesmith.ai (custom domain)
- **Cloudflare Pages subdomain:** https://trip-optimizer-6og.pages.dev (still works as an alias)

## Environment variables

Configured in the Cloudflare Pages dashboard, **not** in repo:

- `ANTHROPIC_API_KEY` — required for `/api/build`, `/api/menu`, `/api/activity-details`, standard mode of `/api/find`, `/api/extract-from-file`, `/api/introduction`
- `PERPLEXITY_API_KEY` — required for `/api/confirm-booking`, `/api/review-retrieve`, local-expert mode of `/api/find`
- `GOOGLE_PLACES_API_KEY` — required for all venue verification (`/api/places-verify`, `/api/places-verify-batch`, the verification pass inside `/api/find`) and for `/api/place-autocomplete`; without it every venue is `UNVERIFIED` and the location field degrades to freeform typing
- `JOBS` — KV namespace binding used as job/cache store; app degrades gracefully if missing (no caching, no resume-after-drop)
- `PLACES` — KV namespace binding for the venue-verification cache (30-day TTL for confirmed venues, 6-hour for negative results); app degrades gracefully if missing (every verify becomes a live Places call)

All endpoints soft-fail when keys / KV are missing — degraded response instead of 500.

**Known gap (as of 2026-06-27):** These are bound to the **Production** environment only. PR preview deploys soft-fail. See `concepts/known-issues.md` #1.

## Scripts (package.json)

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server at http://localhost:5173 (HMR; no SW, no Pages Functions) |
| `npm run build` | Vite production build → `dist/` |
| `npm run preview` | Serve the built bundle locally |
| `npm run lint` | ESLint over `src/` |
| `npm test` | Run all unit suites under `tests/` (`node tests/run-all.mjs`) |

End-to-end local testing of Pages Functions requires Wrangler:

```bash
npm run build
npx wrangler pages dev dist --kv JOBS
# wrangler pages secret put ANTHROPIC_API_KEY
# wrangler pages secret put PERPLEXITY_API_KEY
```

## CI

`.github/workflows/ci.yml` runs three jobs on every push to `master` and every PR:

- **test** — `npm test` (hard gate)
- **lint** — `npm run lint` (currently soft-gate; flip when baseline ~14 errors are cleared)
- **build** — `npm run build` (hard gate)

Cursor Bugbot also runs on PRs.

## Tests

- `tests/` holds offline unit suites for helpers and Cloudflare Functions.
- Plain Node scripts using a tiny custom assert helper; each file prints `N passed, M failed` on its last line.
- `tests/run-all.mjs` runs the whole suite and exits non-zero on any failure.
- Suite size: ~1240 tests across 34 suites (as of 2026-06-27).
