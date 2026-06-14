// Tests for functions/api/routes-verify.js -- mocked fetch + KV.

import { onRequestPost } from "../functions/api/routes-verify.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

const ROUTES_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

function makeReq(body) {
  return new Request("http://localhost/api/routes-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Mock Routes API. byIndex maps each [origin, dest] index pair (we only
// use diagonals) to { duration_seconds, distance_meters }.
function mockRoutes(byIndex) {
  return async (url, opts) => {
    if (url === ROUTES_URL) {
      const body = JSON.parse(opts.body);
      const n = body.origins.length;
      const rows = [];
      for (let i = 0; i < n; i++) {
        const r = byIndex[i];
        if (!r) {
          rows.push({ originIndex: i, destinationIndex: i, condition: "ROUTE_NOT_FOUND" });
          continue;
        }
        rows.push({
          originIndex: i,
          destinationIndex: i,
          condition: "ROUTE_EXISTS",
          duration: `${r.duration_seconds}s`,
          distanceMeters: r.distance_meters,
        });
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error("Unexpected: " + url);
  };
}

// ============================================================
// 1. Malformed JSON
// ============================================================
console.log("\n[1] Malformed JSON");
{
  const ctx = {
    request: new Request("http://localhost/api/routes-verify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
    }),
    env: {},
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  assert("status 400", res.status === 400);
}

// ============================================================
// 2. Empty pairs
// ============================================================
console.log("\n[2] Empty pairs");
{
  const res = await onRequestPost({ request: makeReq({ pairs: [] }), env: {}, waitUntil: () => {} });
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("checked 0", body.summary.checked === 0);
}

// ============================================================
// 3. Single pair resolves
// ============================================================
console.log("\n[3] Single pair");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRoutes({ 0: { duration_seconds: 600, distance_meters: 4500 } });
  const ctx = {
    request: makeReq({
      pairs: [{
        id: "p1",
        originLat: 42.65, originLng: 18.09,
        destLat: 42.66, destLng: 18.10,
        travelMode: "DRIVE",
      }],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found true", body.routes[0].found === true);
  assert("duration_seconds 600", body.routes[0].duration_seconds === 600);
  assert("distance_meters 4500", body.routes[0].distance_meters === 4500);
  assert("summary found:1", body.summary.found === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 4. Missing key -> soft fail
// ============================================================
console.log("\n[4] Missing API key");
{
  const ctx = {
    request: makeReq({
      pairs: [{ id: "p1", originLat: 0, originLng: 0, destLat: 1, destLng: 1, travelMode: "DRIVE" }],
    }),
    env: { PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200 (soft fail)", res.status === 200);
  assert("found false", body.routes[0].found === false);
  assert("error no-key", body.routes[0].error === "no-key");
}

// ============================================================
// 5. Cache hit on second call
// ============================================================
console.log("\n[5] Cache hit");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const base = mockRoutes({ 0: { duration_seconds: 600, distance_meters: 4500 } });
  globalThis.fetch = async (...args) => { callCount++; return base(...args); };
  const kv = makeKV();
  const req = () => ({
    request: makeReq({
      pairs: [{
        id: "p1",
        originLat: 42.65, originLng: 18.09,
        destLat: 42.66, destLng: 18.10,
        travelMode: "DRIVE",
      }],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  });
  await (await onRequestPost(req())).json();
  await new Promise((r) => setTimeout(r, 40));
  const firstCalls = callCount;
  const res = await onRequestPost(req());
  const body = await res.json();
  assert("first call hit network", firstCalls === 1);
  assert("second call hit cache (no new fetch)", callCount === firstCalls);
  assert("cached:true reported", body.routes[0].cached === true);
  assert("cache_hits 1", body.summary.cache_hits === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 6. Cap at MAX_PAIRS (20)
// ============================================================
console.log("\n[6] Cap at 20");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === ROUTES_URL) {
      const body = JSON.parse(opts.body);
      const rows = body.origins.map((_, i) => ({
        originIndex: i, destinationIndex: i,
        condition: "ROUTE_EXISTS", duration: "60s", distanceMeters: 100,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error("nope");
  };
  const pairs = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`,
    originLat: i, originLng: i,
    destLat: i + 0.1, destLng: i + 0.1,
    travelMode: "DRIVE",
  }));
  const ctx = {
    request: makeReq({ pairs }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("capped at 20", body.routes.length === 20);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 7. Mixed modes grouped into separate Routes calls
// ============================================================
console.log("\n[7] Mixed modes grouped");
{
  let driveCalls = 0;
  let walkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === ROUTES_URL) {
      const body = JSON.parse(opts.body);
      if (body.travelMode === "DRIVE") driveCalls += 1;
      if (body.travelMode === "WALK") walkCalls += 1;
      const rows = body.origins.map((_, i) => ({
        originIndex: i, destinationIndex: i,
        condition: "ROUTE_EXISTS", duration: "60s", distanceMeters: 100,
      }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error("nope");
  };
  const ctx = {
    request: makeReq({
      pairs: [
        { id: "a", originLat: 0, originLng: 0, destLat: 1, destLng: 1, travelMode: "DRIVE" },
        { id: "b", originLat: 2, originLng: 2, destLat: 3, destLng: 3, travelMode: "WALK" },
        { id: "c", originLat: 4, originLng: 4, destLat: 5, destLng: 5, travelMode: "DRIVE" },
      ],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("3 routes returned", body.routes.length === 3);
  assert("1 DRIVE call", driveCalls === 1);
  assert("1 WALK call", walkCalls === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 8. ROUTE_NOT_FOUND -> error not-found, cached
// ============================================================
console.log("\n[8] No-route response");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRoutes({}); // index 0 will return ROUTE_NOT_FOUND
  const kv = makeKV();
  const ctx = {
    request: makeReq({
      pairs: [{ id: "p1", originLat: 0, originLng: 0, destLat: 90, destLng: 90, travelMode: "DRIVE" }],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found false", body.routes[0].found === false);
  assert("error not-found", body.routes[0].error === "not-found");
}

// ============================================================
// 9. Transient HTTP error -> error surfaced, NOT cached
// ============================================================
console.log("\n[9] Transient 5xx");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream", { status: 502 });
  const kv = makeKV();
  const ctx = {
    request: makeReq({
      pairs: [{ id: "p1", originLat: 0, originLng: 0, destLat: 1, destLng: 1, travelMode: "DRIVE" }],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200 soft", res.status === 200);
  assert("found false", body.routes[0].found === false);
  assert("error mentions 502", /502/.test(body.routes[0].error || ""));
  await new Promise((r) => setTimeout(r, 30));
  assert("not cached", kv._store.size === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 10. Malformed entries are skipped
// ============================================================
console.log("\n[10] Skip malformed");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRoutes({ 0: { duration_seconds: 60, distance_meters: 100 } });
  const ctx = {
    request: makeReq({
      pairs: [
        null,
        { id: "missing-coords", travelMode: "DRIVE" },
        { id: "bad-mode", originLat: 0, originLng: 0, destLat: 1, destLng: 1, travelMode: "TELEPORT" },
        { id: "good", originLat: 0, originLng: 0, destLat: 1, destLng: 1, travelMode: "DRIVE" },
      ],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("only good pair processed", body.routes.length === 1);
  assert("id 'good'", body.routes[0].id === "good");
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
