// GET /api/flights-search
// ------------------------------------------------------------------
// Thin server-side proxy to the shared FlightAware-backed Worker's
// schedules mode (flight-status.jhwiv-online.workers.dev?mode=schedules).
// Returns published airline timetables for a route + date, optionally
// filtered by airline — used by the wizard / flight cards to surface
// real scheduled departure/arrival times for a planned trip leg.
//
// Why a proxy (mirrors find.js / menu.js): the browser never talks to
// AeroAPI or the Worker directly; this keeps the call path consistent
// with the rest of the app and lets the Worker own the AeroAPI key,
// CORS, and caching. No secrets live here.
//
// Request (query string):
//   date         required  YYYY-MM-DD (UTC departure day)
//   airline?     optional  IATA or ICAO carrier code (e.g. UA / UAL)
//   origin?      optional  IATA or ICAO airport code (e.g. EWR / KEWR)
//   destination? optional  IATA or ICAO airport code (e.g. ZRH / LSZH)
//   (at least one of airline/origin/destination is required)
//
// Returns:
//   200 { ok, mode:"schedules", date, origin, destination, airline,
//         count, flights:[{ ident, identIata, flightNumber,
//         scheduledOut, scheduledIn, origin, destination, aircraft }],
//         fetchedAt }
//   400 { ok:false, error }   — bad/missing params
//   502 { ok:false, error }   — upstream Worker / AeroAPI failure
//
// The Worker URL is overridable via env.FLIGHT_STATUS_WORKER so it is
// not hardcoded as a deploy-time secret; it falls back to the known
// public Worker origin (the Worker holds the actual API key, not us).

const DEFAULT_WORKER = "https://flight-status.jhwiv-online.workers.dev/";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const date = (url.searchParams.get("date") || "").trim();
  const airline = (url.searchParams.get("airline") || "").trim();
  const origin = (url.searchParams.get("origin") || "").trim();
  const destination = (url.searchParams.get("destination") || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ ok: false, error: "invalid or missing date (YYYY-MM-DD)" }, 400);
  }
  if (!airline && !origin && !destination) {
    return json({ ok: false, error: "at least one of airline, origin, destination required" }, 400);
  }

  const workerBase = (env && env.FLIGHT_STATUS_WORKER) || DEFAULT_WORKER;
  const target = new URL(workerBase);
  target.searchParams.set("mode", "schedules");
  target.searchParams.set("date", date);
  if (airline) target.searchParams.set("airline", airline);
  if (origin) target.searchParams.set("origin", origin);
  if (destination) target.searchParams.set("destination", destination);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return json({ ok: false, error: "flight schedules upstream fetch failed", detail: String(err) }, 502);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return json({ ok: false, error: `flight schedules upstream ${upstream.status}`, detail: text.slice(0, 400) }, 502);
  }

  // Pass the Worker's already-normalised JSON straight through.
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
