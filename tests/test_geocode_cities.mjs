// Tests for functions/api/geocode-cities.js — mocked fetch + KV.

import { onRequestPost } from "../functions/api/geocode-cities.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

const PLACES_TS = "https://places.googleapis.com/v1/places:searchText";

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

function makeReq(body) {
  return new Request("http://localhost/api/geocode-cities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockGeo(byName) {
  return async (url, opts) => {
    if (url === PLACES_TS) {
      const body = JSON.parse(opts.body);
      const q = body.textQuery;
      const spec = byName[q];
      if (!spec || spec.notFound) return new Response(JSON.stringify({ places: [] }), { status: 200 });
      if (spec.error) return new Response("upstream", { status: spec.error });
      return new Response(JSON.stringify({
        places: [{
          id: `id_${q.replace(/\s+/g, "_")}`,
          displayName: { text: spec.resolved || q },
          location: { latitude: spec.lat, longitude: spec.lng },
        }],
      }), { status: 200 });
    }
    throw new Error("Unexpected: " + url);
  };
}

// ============================================================
// 1. Malformed JSON → 400
// ============================================================
console.log("\n[1] Malformed JSON");
{
  const ctx = {
    request: new Request("http://localhost/api/geocode-cities", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
    }),
    env: {},
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  assert("status 400", res.status === 400);
}

// ============================================================
// 2. Empty cities array → 200, empty summary
// ============================================================
console.log("\n[2] Empty cities array");
{
  const res = await onRequestPost({ request: makeReq({ cities: [] }), env: {}, waitUntil: () => {} });
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("checked 0", body.summary.checked === 0);
}

// ============================================================
// 3. Single city resolves → lat/lng returned
// ============================================================
console.log("\n[3] Single city resolves");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockGeo({
    "Santa Fe, NM": { lat: 35.687, lng: -105.937 },
  });
  const ctx = {
    request: makeReq({ cities: ["Santa Fe, NM"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found", body.geocodes[0].found === true);
  assert("lat", body.geocodes[0].lat === 35.687);
  assert("lng", body.geocodes[0].lng === -105.937);
  assert("summary found:1", body.summary.found === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 4. Missing API key → soft fail
// ============================================================
console.log("\n[4] Missing API key");
{
  const ctx = {
    request: makeReq({ cities: ["Anywhere"] }),
    env: { PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found false", body.geocodes[0].found === false);
  assert("error no-key", body.geocodes[0].error === "no-key");
}

// ============================================================
// 5. NOT_FOUND → cached
// ============================================================
console.log("\n[5] Zero matches");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockGeo({ "NowhereVille": { notFound: true } });
  const kv = makeKV();
  const ctx = {
    request: makeReq({ cities: ["NowhereVille"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found false", body.geocodes[0].found === false);
  assert("error not-found", body.geocodes[0].error === "not-found");
  await new Promise((r) => setTimeout(r, 30));
  assert("cached", kv._store.size === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 6. Dedup
// ============================================================
console.log("\n[6] Dedup");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const base = mockGeo({ "Rovinj": { lat: 45.0, lng: 13.6 } });
  globalThis.fetch = async (...args) => { callCount++; return base(...args); };
  const ctx = {
    request: makeReq({ cities: ["Rovinj", "Rovinj", "rovinj"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("3 echo rows", body.geocodes.length === 3);
  assert("1 actual lookup", callCount === 1);
  assert("all three have same lat", body.geocodes.every((g) => g.lat === 45.0));
  globalThis.fetch = originalFetch;
}

// ============================================================
// 7. Cap at MAX_CITIES (12)
// ============================================================
console.log("\n[7] Cap at 12");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === PLACES_TS) {
      return new Response(JSON.stringify({ places: [{ id: "x", displayName: { text: "x" }, location: { latitude: 0, longitude: 0 } }] }), { status: 200 });
    }
    throw new Error("nope");
  };
  const cities = Array.from({ length: 30 }, (_, i) => `City${i}`);
  const ctx = {
    request: makeReq({ cities }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("capped at 12", body.geocodes.length === 12);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 8. Cache hit on 2nd call
// ============================================================
console.log("\n[8] Cache hit");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const base = mockGeo({ "Cached City": { lat: 1, lng: 2 } });
  globalThis.fetch = async (...args) => { callCount++; return base(...args); };
  const kv = makeKV();
  const ctxA = {
    request: makeReq({ cities: ["Cached City"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  await (await onRequestPost(ctxA)).json();
  await new Promise((r) => setTimeout(r, 30));
  const first = callCount;
  const ctxB = {
    request: makeReq({ cities: ["Cached City"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctxB);
  const body = await res.json();
  assert("first call hit network", first === 1);
  assert("second call hit cache (no new fetches)", callCount === 1);
  assert("cached:true echoed", body.geocodes[0].cached === true);
  assert("cache_hits 1", body.summary.cache_hits === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 9. Transient 5xx not cached
// ============================================================
console.log("\n[9] 5xx not cached");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockGeo({ "Flaky": { error: 502 } });
  const kv = makeKV();
  const ctx = {
    request: makeReq({ cities: ["Flaky"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found false", body.geocodes[0].found === false);
  assert("error mentions 502", /502/.test(body.geocodes[0].error || ""));
  await new Promise((r) => setTimeout(r, 30));
  assert("not cached", kv._store.size === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// 10. Resolved name surfaced when different from input
// ============================================================
console.log("\n[10] Resolved name");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockGeo({
    "SF": { lat: 35.687, lng: -105.937, resolved: "Santa Fe, NM, USA" },
  });
  const ctx = {
    request: makeReq({ cities: ["SF"] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("resolved_name surfaced", body.geocodes[0].resolved_name === "Santa Fe, NM, USA");
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
