# Flight-number / flight-times resolver gaps (#12 follow-up)

**Status:** RESOLVED 2026-06-30 PM via PR #106 (gap fixes) + PR #108 (cross-carrier times-lift fix discovered during live verification). See handoff.md § Active Investigation. Awaiting real-trip live probe by user. This page kept for the diagnosis, probe data, and the lesson about live-probing after merge.
**Surfaced:** User report 2026-06-30 PM ("flight numbers and times sometimes missing — feels like a fix that gets reverted")
**Severity:** Medium (intermittent; primary PDF data quality)

## Why this is not a regression

A static audit of every commit since PR #84 (the #12 fix, 2026-06-29) shows no code regression on the flight-resolver path. The live bundle (`index-B_4BBtOR.js` as of 2026-06-30 PM) ships every PR #84 anchor:

- `_scheduleVerified` — the canonical-plan persistence flag
- `scheduled operating flight` — the PDF qualifier string
- `FlightNumberAutoResolver` is mounted in `ItineraryView` exactly once

Git blame on the live anchor lines all point to PR #84. The "fix gets reverted" feel is real but it's not code reverting — it's two coverage gaps in #84's original fix firing under different conditions on different builds.

## Gap 1 — API miss → silent bail

`FlightNumberAutoResolver` in `src/App.jsx ~6451` calls `/api/flights-search` to backfill missing flight numbers. The API can return zero rows for several reasons (uncommon carrier filter, uncommon route, near-date edge), and the resolver currently treats every empty result as fatal-for-that-flight:

```js
// src/App.jsx ~6494
const res = await fetch(`/api/flights-search?${params}`);
const j = await res.json().catch(() => ({}));
if (!j.ok || !Array.isArray(j.flights) || j.flights.length === 0) continue;
```

The `catch {}` block at `~6500` does the same for transport errors:

```js
// Silent — a failed lookup just leaves that flight without a number.
```

On miss, the flight stays bare. The PDF then prints carrier only (e.g. "United Airlines · EWR → LAX") with no flight number AND no times in cases where the model also did not emit windows. There is no honest fallback string in the PDF today.

## Gap 2 — Resolver skips flights where the model emitted a number

The bail at `src/App.jsx ~6469`:

```js
if (fl._userSuppliedFlightNumber || hasNum) return;
```

…drops a flight from the `targets[]` list as soon as it has any `flight_number`. The API call never fires for that flight — which means even though the backfill code at `~6517–6518` already handles times…

```js
depart_time: it.flight.depart_time || toT(hit.pick.scheduledOut),
arrive_time: it.flight.arrive_time || toT(hit.pick.scheduledIn),
```

…that path is **unreachable** for any flight where the model emitted a number but omitted times. Times never get backfilled in that case.

The schema (`src/App.jsx ~8835/8860`) requires `depart_time` and `arrive_time`, and the prompt (`~11935`) explicitly tells the model to emit realistic windows even when omitting the flight number. So Gap 2 only fires when the model violates the schema or emits empty-string times that pass the `||` truthy check. Real but rarer than Gap 1.

## Production API probe (2026-06-30 PM)

Eight realistic route+date+airline combinations against `https://www.routesmith.ai/api/flights-search`:

| Route | Airline | Days out | Hits | Note |
|---|---|---|---|---|
| EWR → LAX | UA | 7 | 15 | Dense; mixed UA + codeshares (NZ/TP) |
| EWR → LAX | AA | 7 | **0** | Airline filter miss; AA flies this route |
| EWR → ZRH | UA | 60 | 6 | UA9747 + LH/LX codeshares |
| JFK → LHR | BA | 60 | 15 | Dense; BA + AS/AY codeshares |
| BOS → SFO | B6 | 7 | 15 | Dense |
| DEN → SAF | UA | 7 | 5 | UA Express; 3 daily |
| EWR → LAX | — (route-only) | 7 | 15 | Same route as #2; hits without airline filter |
| JAC → FLG | UA | 7 | **0** | Real route miss; no UA service |

**Headline:** 6 of 8 hit. Of the 2 misses, **one (EWR-LAX-AA) is purely an airline-filter artifact** — the same route+date hits without the filter. The other (JAC-FLG) is a genuine route miss with no service.

**Implication for the fix:** an airline-filter miss should retry once route-only before giving up.

## Authorized fix shape (no code yet)

User approved 2026-06-30 PM, "Go on the shape as described":

1. **Loosen Gap 2's bail.** Change the resolver's per-flight skip from "has number → skip entirely" to "has number AND has times → skip; has number but missing times → still query the API for times-only backfill." When the resolved row's carrier matches, write `depart_time`/`arrive_time` only; never overwrite a present number.

2. **Airline-filter retry on miss (Gap 1, partial recovery).** When `/api/flights-search?airline=…&origin=…&destination=…&date=…` returns 0 rows, retry once **without** the airline filter. Filter the second response by `pool.filter(x => x.flightNumber.startsWith(iata))` first (to recover when the upstream worker stripped the airline param incorrectly); if that pool is empty AND the model emitted a number, look for an exact `flightNumber` match in the route-only result and lift times from it. Never lift a *number* from a route-only result — too easy to grab the wrong carrier.

3. **Honest PDF fallback for total miss (Gap 1, when neither attempt resolves).** When both the airline-filtered and route-only calls return 0 rows AND the model also omitted times, persist `_timesUnconfirmed: true` on the flight object (alongside the existing `_scheduleVerified` pattern), and have `src/pdf/itineraryPdf.js` emit "Times not yet confirmed — check with airline at booking" instead of a blank line.

4. **Tests** (`tests/test_flight_resolver.mjs`):
   - Case A: Model omits both → API miss (both attempts) → fallback text appears in plan + PDF
   - Case B: Model emits number only → resolver still hits the API to backfill times
   - Case C: Model emits everything → no resolver call needed (existing guard still works)
   - Case D: Model omits both → airline-filter miss → route-only retry hits → number + times backfilled

5. **PR will carry the standard "Needs live confirmation" checklist** — Denver UA build (known-good happy path); EWR-LAX-AA build (Gap 1 airline-filter miss recovered via route-only retry); JAC-FLG build (true miss → fallback string shown in PDF).

## Anchors

- `src/App.jsx ~6451` — `FlightNumberAutoResolver` function start
- `src/App.jsx ~6469` — Gap 2 bail
- `src/App.jsx ~6494` — Gap 1 API miss continue
- `src/App.jsx ~6500` — Gap 1 transport-error catch (silent)
- `src/App.jsx ~6517–6518` — times-backfill code (currently unreachable for Gap 2)
- `src/App.jsx ~8835/8860` — Flight schema (requires `depart_time` / `arrive_time`)
- `src/App.jsx ~11935` — prompt rule telling model to emit windows
- `functions/api/flights-search.js` — thin proxy to FlightAware-backed worker, schedules mode
- `src/pdf/itineraryPdf.js ~1039` — PDF reads `fl.flight_number`

## Why this is in the wiki, not just personal memory

The same reasons #24 belongs here:

- Changes data-quality code on a hot path (`App.jsx`).
- Layers on top of #12, which has its own wiki entry and which the user has now seen partially re-fail.
- A future thread needs the probe data, the diagnosis-vs-gap mapping, and the "wiki entries are hypotheses; re-verify" lesson without re-deriving any of it.

## Process note

This page was written before any code change, per the user's build-process rule. The fix PR will reference this page and update its status block. The handoff table's #12 row carries a forward-pointer to this page so the in-flight follow-up doesn't get lost.
