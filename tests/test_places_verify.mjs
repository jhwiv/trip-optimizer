// Tests for functions/api/places-verify.js — pure unit tests with mocked
// fetch and an in-memory KV stand-in. No network, no Cloudflare runtime.
//
// Coverage:
//   1.  Malformed JSON                              → 400
//   2.  Missing `name`                              → 400
//   3.  Missing GOOGLE_PLACES_API_KEY               → found:false, error:"no-key"
//   4.  Text Search returns zero candidates         → found:false, error:"not-found", cached
//   5.  Operational venue                           → found:true, business_status defaults to OPERATIONAL
//   6.  CLOSED_PERMANENTLY surfaced                 → business_status echoed verbatim
//   7.  Cache hit on second call                    → no fetches, cached:true
//   8.  Missing env.PLACES                          → still works, just no caching
//   9.  Transient 5xx                               → found:false with error, NOT cached
//  10.  HTTP timeout                                → found:false with error, NOT cached
//  11.  Cache key is sensitive to name             AND insensitive to case / whitespace
//  12.  Location bias passed when lat/lng provided

import { onRequestPost } from "../functions/api/places-verify.js";

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// ---- In-memory KV --------------------------------------------------------
function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

// ---- Mock Places responses ----------------------------------------------
function textSearchResp(places) {
  return new Response(JSON.stringify({ places }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function detailsResp(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- Request helper -----------------------------------------------------
function makeReq(body) {
  return new Request("http://localhost/api/places-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_PREFIX = "https://places.googleapis.com/v1/places/";

// ============================================================
// Test 1: Malformed JSON → 400
// ============================================================
console.log("\n[1] Malformed JSON");
{
  const ctx = {
    request: new Request("http://localhost/api/places-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
    env: {},
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("returns 400", res.status === 400);
  assert("found:false", body.found === false);
}

// ============================================================
// Test 2: Missing `name` → 400
// ============================================================
console.log("\n[2] Missing name");
{
  const ctx = {
    request: makeReq({ city: "Santa Fe" }),
    env: {},
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  assert("returns 400", res.status === 400);
}

// ============================================================
// Test 3: Missing GOOGLE_PLACES_API_KEY → found:false, error:"no-key"
// ============================================================
console.log("\n[3] Missing GOOGLE_PLACES_API_KEY → soft fail");
{
  const ctx = {
    request: makeReq({ name: "Le Bernardin", city: "New York" }),
    env: { PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found false", body.found === false);
  assert("error no-key", body.error === "no-key");
}

// ============================================================
// Test 4: Text Search returns zero candidates → not-found, cached
// ============================================================
console.log("\n[4] Zero candidates → not-found (cached)");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    callCount++;
    if (url === TEXT_SEARCH_URL) return textSearchResp([]);
    throw new Error("Unexpected fetch: " + url);
  };
  const kv = makeKV();
  const ctx = {
    request: makeReq({ name: "Nonexistent Spot", city: "Nowhere" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found false", body.found === false);
  assert("error not-found", body.error === "not-found");
  assert("1 fetch (no Details call)", callCount === 1, `got ${callCount}`);
  await new Promise((r) => setTimeout(r, 50));
  assert("not-found result cached", kv._store.size === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 5: Operational venue (businessStatus omitted by Places) → OPERATIONAL
// ============================================================
console.log("\n[5] Operational venue — businessStatus omitted defaults OPERATIONAL");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === TEXT_SEARCH_URL) {
      return textSearchResp([{
        id: "place_abc",
        displayName: { text: "Geronimo" },
        location: { latitude: 35.685, longitude: -105.940 },
      }]);
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      // businessStatus deliberately omitted — Places does this for OPERATIONAL places
      return detailsResp({
        id: "place_abc",
        displayName: { text: "Geronimo" },
        formattedAddress: "724 Canyon Rd, Santa Fe, NM 87501, USA",
        internationalPhoneNumber: "+1 505-982-1500",
        regularOpeningHours: {
          weekdayDescriptions: [
            "Monday: 5:00 – 9:30 PM",
            "Tuesday: 5:00 – 9:30 PM",
          ],
        },
        websiteUri: "https://geronimorestaurant.com/",
        location: { latitude: 35.685, longitude: -105.940 },
      });
    }
    throw new Error("Unexpected fetch: " + url);
  };
  const ctx = {
    request: makeReq({ name: "Geronimo", city: "Santa Fe" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found true", body.found === true);
  assert("business_status defaults OPERATIONAL", body.business_status === "OPERATIONAL");
  assert("place_id from details", body.place_id === "place_abc");
  assert("address set", body.address?.includes("Canyon Rd"));
  assert("phone set", body.phone === "+1 505-982-1500");
  assert("hours array length 2", Array.isArray(body.hours) && body.hours.length === 2);
  assert("website set", body.website === "https://geronimorestaurant.com/");
  assert("lat/lng set", body.lat === 35.685 && body.lng === -105.940);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 6: CLOSED_PERMANENTLY surfaced verbatim
// ============================================================
console.log("\n[6] CLOSED_PERMANENTLY surfaced");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === TEXT_SEARCH_URL) {
      return textSearchResp([{
        id: "place_closed",
        displayName: { text: "The Waterhouse" },
      }]);
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      return detailsResp({
        id: "place_closed",
        displayName: { text: "The Waterhouse" },
        businessStatus: "CLOSED_PERMANENTLY",
        formattedAddress: "123 Closed Ln",
      });
    }
    throw new Error("Unexpected fetch: " + url);
  };
  const ctx = {
    request: makeReq({ name: "The Waterhouse", city: "Peterborough" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found true", body.found === true);
  assert("business_status CLOSED_PERMANENTLY", body.business_status === "CLOSED_PERMANENTLY");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 7: Cache hit on second call → no fetches, cached:true
// ============================================================
console.log("\n[7] Cache hit on second call");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    callCount++;
    if (url === TEXT_SEARCH_URL) {
      return textSearchResp([{ id: "p1", displayName: { text: "Cached" } }]);
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      return detailsResp({
        id: "p1",
        displayName: { text: "Cached" },
        formattedAddress: "1 Main St",
      });
    }
    throw new Error("Unexpected: " + url);
  };
  const kv = makeKV();
  const ctx1 = {
    request: makeReq({ name: "Cached", city: "City" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  await (await onRequestPost(ctx1)).json();
  await new Promise((r) => setTimeout(r, 50));
  const firstCount = callCount;

  const ctx2 = {
    request: makeReq({ name: "Cached", city: "City" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res2 = await onRequestPost(ctx2);
  const body2 = await res2.json();
  assert("first call made 2 fetches (TextSearch + Details)", firstCount === 2, `got ${firstCount}`);
  assert("second call made 0 new fetches", callCount === firstCount, `got total ${callCount}`);
  assert("cached:true on second call", body2.cached === true);
  assert("payload preserved", body2.address === "1 Main St");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 8: Missing env.PLACES → still works, just no caching
// ============================================================
console.log("\n[8] Missing env.PLACES — endpoint still works");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === TEXT_SEARCH_URL) {
      return textSearchResp([{ id: "p2", displayName: { text: "NoKV" } }]);
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      return detailsResp({ id: "p2", displayName: { text: "NoKV" } });
    }
    throw new Error("Unexpected: " + url);
  };
  const ctx = {
    request: makeReq({ name: "NoKV", city: "City" }),
    env: { GOOGLE_PLACES_API_KEY: "k" }, // no PLACES
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found true", body.found === true);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 9: Transient 5xx → found:false, error set, NOT cached
// ============================================================
console.log("\n[9] Transient 5xx — not cached");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream error", { status: 502 });
  const kv = makeKV();
  const ctx = {
    request: makeReq({ name: "FlakyPlace", city: "City" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200 (soft fail)", res.status === 200);
  assert("found false", body.found === false);
  assert("error includes 502", String(body.error || "").includes("502"));
  await new Promise((r) => setTimeout(r, 50));
  assert("transient error NOT cached", kv._store.size === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 10: HTTP timeout → found:false, error set, NOT cached
// ============================================================
console.log("\n[10] HTTP timeout — not cached");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new DOMException("Aborted", "AbortError");
  };
  const kv = makeKV();
  const ctx = {
    request: makeReq({ name: "Hangs", city: "City" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("found false", body.found === false);
  assert("error mentions Aborted", String(body.error || "").includes("Aborted"));
  await new Promise((r) => setTimeout(r, 50));
  assert("abort NOT cached", kv._store.size === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 11: Cache key — case/whitespace insensitive, name-sensitive
// ============================================================
console.log("\n[11] Cache key normalization");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    callCount++;
    if (url === TEXT_SEARCH_URL) {
      return textSearchResp([{ id: "p3", displayName: { text: "Bar" } }]);
    }
    return detailsResp({ id: "p3", displayName: { text: "Bar" } });
  };
  const kv = makeKV();
  // First call writes cache
  await (await onRequestPost({
    request: makeReq({ name: "Bar", city: "Boston" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  })).json();
  await new Promise((r) => setTimeout(r, 50));
  const initialCalls = callCount;

  // Same lookup with different case + extra whitespace → cache hit
  const res2 = await onRequestPost({
    request: makeReq({ name: "  BAR  ", city: "boston" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  });
  const body2 = await res2.json();
  assert("case/whitespace variant hits cache", callCount === initialCalls, `got total ${callCount}`);
  assert("cached:true reported", body2.cached === true);

  // Different name → cache miss → new fetches
  await (await onRequestPost({
    request: makeReq({ name: "Different Name", city: "Boston" }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  })).json();
  assert("different name re-fetches", callCount > initialCalls, `got total ${callCount}`);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 12: Location bias passed in Text Search body when lat/lng given
// ============================================================
console.log("\n[12] Location bias on lat/lng");
{
  let capturedBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === TEXT_SEARCH_URL) {
      capturedBody = JSON.parse(opts.body);
      return textSearchResp([{ id: "p4", displayName: { text: "Geo" } }]);
    }
    return detailsResp({ id: "p4", displayName: { text: "Geo" } });
  };
  await (await onRequestPost({
    request: makeReq({ name: "Geo", city: "City", lat: 35.7, lng: -105.9 }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: () => {},
  })).json();
  assert("textQuery built from name+city", capturedBody?.textQuery === "Geo, City");
  assert("locationBias.circle.center.latitude set", capturedBody?.locationBias?.circle?.center?.latitude === 35.7);
  assert("locationBias.circle.center.longitude set", capturedBody?.locationBias?.circle?.center?.longitude === -105.9);
  assert("locationBias.circle.radius set", capturedBody?.locationBias?.circle?.radius === 50000);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
