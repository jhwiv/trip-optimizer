# Trip Optimizer

A luxury-tier travel-planning web app. Two surfaces share one bundle:

- **`/` — Full itinerary build.** A three-step wizard (Essentials → Details → Your plan) that turns a free-text trip brief into a day-by-day itinerary with hotels, restaurants, activities, and ground transport.
- **`/find` — Quick search.** A single-screen lookup for restaurants and activities in a given location, with an automatic "locals' picks" pass appended below the standard results.

Live at https://trip-optimizer-6og.pages.dev/.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite |
| Hosting | Cloudflare Pages |
| API | Cloudflare Pages Functions (`functions/api/*.js`) |
| LLM | Anthropic Claude Sonnet 4.5 (builds, reviews, edits, menus) |
| Retrieval | Perplexity Sonar (local-knowledge passes, booking-platform confirmation) |
| Cache | Cloudflare KV (`JOBS` binding) |
| PWA | Service worker with network-first HTML + cache-first hashed assets |

No build step beyond `vite build`. No backend server beyond Pages Functions.

---

## Routing model

Routing happens in `src/main.jsx`, **before** any component tree mounts. A regex (`/^\/find(\/|\?|$)/`) decides whether `App` (the wizard, default export of `App.jsx`) or `FindView` (named export) renders. This sidesteps React's rules-of-hooks because there's no early return inside a hook-using component.

There is no client-side router beyond this single branch — both surfaces are SPA pages with their own complete UI.

---

## API surface (Cloudflare Pages Functions)

| Endpoint | Purpose |
|---|---|
| `POST /api/build` | Streams Anthropic build via NDJSON. KV-backed job poll fallback when the SSE stream drops. |
| `POST /api/find` | Restaurants + activities lookup. Standard mode uses Anthropic; local-expert mode fans out to Sonar across reviewer sources. KV-cached per (source, query). |
| `POST /api/menu` | Lazy menu fetch for a named restaurant + location. Sonar-grounded. KV-cached. |
| `POST /api/activity-details` | Lazy expanded details for a named activity. |
| `POST /api/confirm-booking` | Grounds reservation.platform (Resy/OpenTable/Tock/phone/walkin) + website on Sonar. KV-cached 30 days. |
| `POST /api/review-retrieve` | Pulls editorial snippets from default reviewer sources (CN Traveler, Michelin, NYT 36 Hours, Reddit, Atlas Obscura, Substack) for grounding builds and reviews. |
| `POST /api/verify-url` | URL liveness check for finding citations. |
| `POST /api/extract-from-file` | Reads a previously-built itinerary (PDF/docx/paste) into Trip Optimizer's structured plan shape. |
| `POST /api/extract-trip` | (legacy) Variant of extract-from-file for plain-text inputs. |

All endpoints soft-fail: missing API keys or KV binding return a degraded response rather than 500, so the app stays usable in partial outages.

---

## Environment variables

Configured in the Cloudflare Pages dashboard, not in repo:

- `ANTHROPIC_API_KEY` — required for `/api/build`, `/api/menu`, `/api/activity-details`, the standard mode of `/api/find`, `/api/extract-from-file`
- `PERPLEXITY_API_KEY` — required for `/api/confirm-booking`, `/api/review-retrieve`, local-expert mode of `/api/find`
- `GOOGLE_PLACES_API_KEY` — required for all venue verification (`/api/places-verify`, `/api/places-verify-batch`, the verification pass inside `/api/find`) and for `/api/place-autocomplete`. Without it every venue is `UNVERIFIED` and the location field falls back to freeform typing.
- `JOBS` — KV namespace binding used as a job/cache store. App degrades gracefully if missing (no caching, no resume-after-drop).
- `PLACES` — KV namespace binding for the venue-verification cache (30-day TTL for confirmed venues, 6-hour for negative results). App degrades gracefully if missing (every verify is a live Places call).

---

## Local development

```bash
git clone https://github.com/jhwiv/trip-optimizer.git
cd trip-optimizer
npm install
npm run dev     # Vite at http://localhost:5173
```

Pages Functions don't run under `vite dev` — for end-to-end local testing use the Cloudflare Wrangler CLI:

```bash
npm run build
npx wrangler pages dev dist --kv JOBS
```

Then set keys via `wrangler pages secret put ANTHROPIC_API_KEY` etc.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (HMR, no SW, no Pages Functions) |
| `npm run build` | Vite production build → `dist/` |
| `npm run preview` | Serve the built bundle locally |
| `npm run lint` | ESLint over `src/` |
| `npm test` | Run all unit suites under `tests/` |

---

## Tests

`tests/` holds offline unit suites for the helpers and Cloudflare Functions. Each test file is a plain Node script that uses a tiny custom assert helper and prints `N passed, M failed` on its last line. `tests/run-all.mjs` runs the whole suite and exits non-zero if any fails.

```bash
npm test     # 247 tests across 8 suites at time of writing
```

CI runs the suite on every PR; see `.github/workflows/ci.yml`.

---

## CI

`.github/workflows/ci.yml` runs three jobs on every push to master and every PR:

- **test** — `npm test` (hard gate)
- **lint** — `npm run lint` (currently soft-gate; flip when the baseline 14 errors are cleared)
- **build** — `npm run build` (hard gate)

---

## Project conventions

- **Maintenance mode.** The app is feature-complete and only takes targeted tweaks. Larger architectural changes need explicit approval.
- **Anti-guessing.** Never invent file paths, env vars, branding, URLs, or UI labels. Mark uncertain items `UNVERIFIED` and verify against the actual source.
- **Scope discipline.** Edits stay literal and minimal; unrelated code stays byte-for-byte intact.
- **Live verification.** No "fixed" claims without a live-surface check on the production URL.
- **No dead code.** Unused symbols and endpoints are deleted, not preserved "just in case".

These conventions are enforced socially today; CI gates them moving forward.
