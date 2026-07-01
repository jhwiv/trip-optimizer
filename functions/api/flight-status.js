// GET /api/flight-status
// ------------------------------------------------------------------
// Thin server-side proxy to the shared FlightAware-backed Worker's
// live-status mode (flight-status.jhwiv-online.workers.dev?ident=…&date=…).
// Returns the live/scheduled status for a single flight ident on a date.
//
// Why a proxy (mirrors flights-search.js): the shared Worker's CORS
// allowlist is pinned to ONE app origin (santafejune.com), so a direct
// browser fetch from routesmith.ai is blocked by CORS — which silently
// broke the LiveFlightStatus panel on every flight card. Routing through
// this same-origin Pages Function removes CORS from the equation entirely
// (server-to-Worker calls aren't subject to browser CORS), so live status
// works on EVERY app that ships this function, regardless of the Worker's
// allowlist. The Worker still owns the AeroAPI key, caching, and the
// status normalisation; no secrets live here.
//
// Request (query string):
//   ident   required  flight ident, e.g. "UA670" / "UAL670"
//   date    required  YYYY-MM-DD (UTC departure day)
//
// Returns:
//   200 { ok, ident, requestedDate, status, statusLevel, note?, … }  — passthrough
//   400 { ok:false, error }   — bad/missing params
//   502 { ok:false, error }   — upstream Worker / AeroAPI failure
//
// The Worker URL is overridable via env.FLIGHT_STATUS_WORKER (same env var
// flights-search.js uses); falls back to the known public Worker origin.

const DEFAULT_WORKER = "https://flight-status.jhwiv-online.workers.dev/";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const ident = (url.searchParams.get("ident") || "").trim();
  const date = (url.searchParams.get("date") || "").trim();

  if (!ident) {
    return json({ ok: false, error: "missing ident" }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ ok: false, error: "invalid or missing date (YYYY-MM-DD)" }, 400);
  }

  const workerBase = (env && env.FLIGHT_STATUS_WORKER) || DEFAULT_WORKER;
  const target = new URL(workerBase);
  // Live-status mode is the Worker's default (no mode= param), matching the
  // original direct call shape: ?ident=…&date=…
  target.searchParams.set("ident", ident);
  target.searchParams.set("date", date);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return json({ ok: false, error: "flight status upstream fetch failed", detail: String(err) }, 502);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return json({ ok: false, error: `flight status upstream ${upstream.status}`, detail: text.slice(0, 400) }, 502);
  }

  // Pass the Worker's already-normalised JSON straight through. Short cache:
  // live status changes, so don't over-cache (the Worker caches its own
  // AeroAPI calls; this is just edge relief).
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
