# API Endpoints

All endpoints are Cloudflare Pages Functions under `functions/api/`. Every endpoint soft-fails (missing API keys or KV binding return a degraded response instead of 500), so the app stays usable in partial outages.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/build` | POST | Streams Anthropic build via NDJSON. KV-backed job poll fallback when the SSE stream drops. Chunked for large trips with auto-resume. |
| `/api/find` | POST | Restaurants + activities lookup. Standard mode = Anthropic. Local-expert mode = Sonar fan-out across reviewer sources. KV-cached per `(source, query)`. |
| `/api/find-providers` | POST | Local providers (drivers, guides, tours, wine tastings) with verification + fetch gating (PR #65). |
| `/api/menu` | POST | Lazy menu fetch for a named restaurant + location. Sonar-grounded. KV-cached. |
| `/api/activity-details` | POST | Lazy expanded details for a named activity. |
| `/api/confirm-booking` | POST | Grounds `reservation.platform` (Resy/OpenTable/Tock/phone/walkin) + website on Sonar. KV-cached 30 days. |
| `/api/review-retrieve` | POST | Pulls editorial snippets from default reviewer sources (Condé Nast Traveler, Michelin, NYT 36 Hours, Reddit, Atlas Obscura, Substack) for grounding builds and reviews. |
| `/api/verify-url` | POST | URL liveness check for finding citations. |
| `/api/places-verify` | POST | Google Places verification with name-similarity guard. |
| `/api/places-verify-batch` | POST | Batch variant, chunked to stay under the Workers subrequest cap (PR #44). |
| `/api/routes-verify` | POST | Routes API travel-time grounding → `PACING_IMPOSSIBLE` / `PACING_CONFLICT` flags. |
| `/api/geocode-cities` | POST | City geocoding used by location radius checks. |
| `/api/place-autocomplete` | POST | Live-typing place suggestions for the `/find` LOCATION field (Google Places Autocomplete New, proxied). Soft-fails to `{ suggestions: [] }`. |
| `/api/flights-search` | POST | Real scheduled flight numbers + times surfaced on flight cards (PRs #59, #62). |
| `/api/introduction` | POST | Post-build trip introduction generation (arc + differentiators). Powers PDF intro section (PR #67). |
| `/api/extract-from-file` | POST | Reads a previously-built itinerary (PDF/docx/paste) into Trip Optimizer's structured plan shape. |
| `/api/extract-trip` | POST | (legacy) Variant of extract-from-file for plain-text inputs. |

## Subfolders

- `functions/api/build/` — helpers for the chunked build pipeline
- `functions/api/experiences/` — auxiliary experience-side endpoints
- `functions/api/inbound/` — inbound parsing helpers (paired with `extract-from-file`)

## External dependencies

- **Anthropic API** (Claude Sonnet 4.5) — primary LLM for builds, reviews, edits, menus
- **Perplexity Sonar** — retrieval + grounding (booking confirmation, review snippets, local-expert mode)
- **Google Places** — venue verification
- **Google Routes API** — travel-time grounding
- **Cloudflare KV** (`JOBS` binding) — job state + per-query caching
