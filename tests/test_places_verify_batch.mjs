// Tests for functions/api/places-verify-batch.js — pure unit tests with
// mocked fetch and in-memory KV. No network.
//
// Coverage:
//   1.  Malformed JSON                          → 400
//   2.  Empty venues array                      → 200 with empty summary
//   3.  Operational venue                       → flags=[]
//   4.  CLOSED_PERMANENTLY                      → block flag
//   5.  CLOSED_TEMPORARILY                      → block flag
//   6.  NOT_FOUND                               → block flag
//   7.  Missing API key                         → UNVERIFIED warn flag
//   8.  Transient 5xx                           → UNVERIFIED warn flag, not cached
//   9.  Dedup — same name twice                 → 1 Places call, 2 echo rows
//  10.  Cap at MAX_VENUES=12 (Cloudflare Workers subrequest budget)
//  11.  Cache hit on 2nd run                    → 0 new Places calls
//  12.  Mixed batch: 1 open, 1 closed, 1 not-found → summary tally correct
//  13.  Kind echoed in response
//  14.  Address/phone/hours/website passthrough
//  15.  Soft-fail: malformed entries skipped, others processed
//  16.  Name mismatch: blocks a restaurant, only warns a hotel
//  17.  Zero results still blocks a hotel
//  18.  CLOSED_PERMANENTLY still blocks a hotel
//  19.  Hotels share the kind-agnostic name+city cache

import { onRequestPost } from "../functions/api/places-verify-batch.js";

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

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

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

function makeReq(body) {
  return new Request("http://localhost/api/places-verify-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAILS_PREFIX = "https://places.googleapis.com/v1/places/";

// Builds a mock fetch that maps a list of (name → response shape) pairs.
// Each name has either { open: true, ...fields } or { closed: <status> }
// or { notFound: true } or { error: <httpStatus> }.
function mockPlaces(specs) {
  let pending = null; // captures the most-recently-looked-up name for Details routing
  return async (url, opts) => {
    if (url === TEXT_SEARCH_URL) {
      const body = JSON.parse(opts.body);
      const name = body.textQuery.split(",")[0].trim();
      const spec = specs[name];
      if (!spec) throw new Error(`Test bug: no spec for ${name}`);
      if (spec.error) return new Response("upstream", { status: spec.error });
      if (spec.notFound) return textSearchResp([]);
      pending = name;
      return textSearchResp([{
        id: `id_${name.replace(/\s+/g, "_")}`,
        // `resolvesTo` simulates Places' fuzzy matching answering with a
        // different venue than the one asked for — the case the
        // name-similarity guard exists to catch.
        displayName: { text: spec.resolvesTo || name },
        location: { latitude: spec.lat ?? 0, longitude: spec.lng ?? 0 },
      }]);
    }
    if (url.startsWith(DETAILS_PREFIX)) {
      const spec = specs[pending];
      if (!spec) throw new Error(`Test bug: no pending name for details ${url}`);
      const obj = {
        id: `id_${pending.replace(/\s+/g, "_")}`,
        displayName: { text: pending },
      };
      if (spec.closed) obj.businessStatus = spec.closed;
      if (spec.address) obj.formattedAddress = spec.address;
      if (spec.phone) obj.internationalPhoneNumber = spec.phone;
      if (spec.hours) obj.regularOpeningHours = { weekdayDescriptions: spec.hours };
      if (spec.website) obj.websiteUri = spec.website;
      if (typeof spec.lat === "number") obj.location = { latitude: spec.lat, longitude: spec.lng };
      return detailsResp(obj);
    }
    throw new Error("Unexpected fetch: " + url);
  };
}

// ============================================================
// Test 1: Malformed JSON → 400
// ============================================================
console.log("\n[1] Malformed JSON");
{
  const ctx = {
    request: new Request("http://localhost/api/places-verify-batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
    env: {},
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  assert("returns 400", res.status === 400);
}

// ============================================================
// Test 2: Empty venues
// ============================================================
console.log("\n[2] Empty venues");
{
  const ctx = { request: makeReq({ venues: [] }), env: {}, waitUntil: () => {} };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("empty verifications", body.verifications.length === 0);
  assert("checked 0", body.summary.checked === 0);
}

// ============================================================
// Test 3: Operational venue
// ============================================================
console.log("\n[3] Operational venue → no flags");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "Geronimo": { open: true, address: "724 Canyon Rd", phone: "+1 505-982-1500" },
  });
  const ctx = {
    request: makeReq({ venues: [{ name: "Geronimo", city: "Santa Fe" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found true", body.verifications[0].found === true);
  assert("business_status OPERATIONAL", body.verifications[0].business_status === "OPERATIONAL");
  assert("no flags", body.verifications[0].flags.length === 0);
  assert("address echoed", body.verifications[0].address === "724 Canyon Rd");
  assert("phone echoed", body.verifications[0].phone === "+1 505-982-1500");
  assert("summary blocked 0", body.summary.blocked === 0);
  assert("summary warnings 0", body.summary.warnings === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 4: CLOSED_PERMANENTLY
// ============================================================
console.log("\n[4] CLOSED_PERMANENTLY → block flag");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "The Waterhouse": { closed: "CLOSED_PERMANENTLY" },
  });
  const ctx = {
    request: makeReq({ venues: [{ name: "The Waterhouse", city: "Peterborough" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found true (Places returned it)", body.verifications[0].found === true);
  assert("flag code CLOSED_PERMANENTLY", body.verifications[0].flags[0]?.code === "CLOSED_PERMANENTLY");
  assert("severity block", body.verifications[0].flags[0]?.severity === "block");
  assert("summary blocked 1", body.summary.blocked === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 5: CLOSED_TEMPORARILY
// ============================================================
console.log("\n[5] CLOSED_TEMPORARILY → block flag");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "Renovating Spot": { closed: "CLOSED_TEMPORARILY" },
  });
  const ctx = {
    request: makeReq({ venues: [{ name: "Renovating Spot", city: "City" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("flag CLOSED_TEMPORARILY", body.verifications[0].flags[0]?.code === "CLOSED_TEMPORARILY");
  assert("severity block", body.verifications[0].flags[0]?.severity === "block");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 6: NOT_FOUND → block flag
// ============================================================
console.log("\n[6] NOT_FOUND → block flag");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "Roxanich": { notFound: true },
  });
  const ctx = {
    request: makeReq({ venues: [{ name: "Roxanich", city: "Motovun" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found false", body.verifications[0].found === false);
  assert("flag NOT_FOUND", body.verifications[0].flags[0]?.code === "NOT_FOUND");
  assert("severity block", body.verifications[0].flags[0]?.severity === "block");
  assert("summary blocked 1", body.summary.blocked === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 7: Missing API key → UNVERIFIED warn
// ============================================================
console.log("\n[7] Missing API key → UNVERIFIED warn");
{
  const ctx = {
    request: makeReq({ venues: [{ name: "Anything", city: "Anywhere" }] }),
    env: { PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("found false", body.verifications[0].found === false);
  assert("flag UNVERIFIED", body.verifications[0].flags[0]?.code === "UNVERIFIED");
  assert("severity warn", body.verifications[0].flags[0]?.severity === "warn");
  assert("summary warnings 1", body.summary.warnings === 1);
  assert("summary blocked 0", body.summary.blocked === 0);
}

// ============================================================
// Test 8: Transient 5xx → UNVERIFIED warn, not cached
// ============================================================
console.log("\n[8] Transient 5xx → UNVERIFIED, not cached");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "FlakyPlace": { error: 502 },
  });
  const kv = makeKV();
  const ctx = {
    request: makeReq({ venues: [{ name: "FlakyPlace", city: "City" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("flag UNVERIFIED", body.verifications[0].flags[0]?.code === "UNVERIFIED");
  await new Promise((r) => setTimeout(r, 50));
  assert("transient error NOT cached", kv._store.size === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 9: Dedup — same name twice → 1 Places call, 2 echo rows
// ============================================================
console.log("\n[9] Dedup");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const baseMock = mockPlaces({
    "Geronimo": { open: true, address: "724 Canyon Rd" },
  });
  globalThis.fetch = async (...args) => {
    callCount++;
    return baseMock(...args);
  };
  const ctx = {
    request: makeReq({
      venues: [
        { name: "Geronimo", city: "Santa Fe" },
        { name: "Geronimo", city: "Santa Fe" }, // duplicate
        { name: "geronimo", city: "santa fe" }, // case variant — same identity
      ],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("2 Places calls (TextSearch + Details, only once)", callCount === 2, `got ${callCount}`);
  assert("3 verifications (one per request entry)", body.verifications.length === 3);
  assert("all three have same address", body.verifications.every((v) => v.address === "724 Canyon Rd"));
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 10: Cap at MAX_VENUES=12 (Cloudflare Workers subrequest budget)
// ============================================================
console.log("\n[10] Cap at MAX_VENUES (12)");
{
  const originalFetch = globalThis.fetch;
  // Mock that handles any name as "open"
  globalThis.fetch = async (url, opts) => {
    if (url === TEXT_SEARCH_URL) {
      const body = JSON.parse(opts.body);
      const name = body.textQuery.split(",")[0].trim();
      return textSearchResp([{ id: `id_${name}`, displayName: { text: name } }]);
    }
    return detailsResp({ id: "x", displayName: { text: "x" } });
  };
  const venues = Array.from({ length: 80 }, (_, i) => ({ name: `V${i}`, city: "X" }));
  const ctx = {
    request: makeReq({ venues }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("capped at 12", body.verifications.length === 12);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 11: Cache hit on 2nd run
// ============================================================
console.log("\n[11] Cache hit");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  const baseMock = mockPlaces({
    "CachedSpot": { open: true, address: "1 Main" },
  });
  globalThis.fetch = async (...args) => {
    callCount++;
    return baseMock(...args);
  };
  const kv = makeKV();
  const ctxA = {
    request: makeReq({ venues: [{ name: "CachedSpot", city: "City" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  await (await onRequestPost(ctxA)).json();
  await new Promise((r) => setTimeout(r, 50));
  const firstCalls = callCount;
  const ctxB = {
    request: makeReq({ venues: [{ name: "CachedSpot", city: "City" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctxB);
  const body = await res.json();
  assert("first run 2 fetches", firstCalls === 2);
  assert("second run 0 new fetches", callCount === firstCalls);
  assert("cached:true on response", body.verifications[0].cached === true);
  assert("cache_hits 1 in summary", body.summary.cache_hits === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 12: Mixed batch
// ============================================================
console.log("\n[12] Mixed batch: open + closed + not-found");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "GoodPlace": { open: true },
    "ClosedPlace": { closed: "CLOSED_PERMANENTLY" },
    "Ghost": { notFound: true },
  });
  const ctx = {
    request: makeReq({
      venues: [
        { name: "GoodPlace", city: "X" },
        { name: "ClosedPlace", city: "X" },
        { name: "Ghost", city: "X" },
      ],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("3 verifications", body.verifications.length === 3);
  assert("summary checked 3", body.summary.checked === 3);
  assert("summary blocked 2", body.summary.blocked === 2, `got ${body.summary.blocked}`);
  assert("GoodPlace no flags", body.verifications.find((v) => v.name === "GoodPlace").flags.length === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 13: Kind echoed
// ============================================================
console.log("\n[13] Kind echoed in response");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({ "Spot": { open: true } });
  const ctx = {
    request: makeReq({ venues: [{ name: "Spot", city: "X", kind: "restaurant" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("kind echoed", body.verifications[0].kind === "restaurant");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 14: Address/phone/hours/website passthrough
// ============================================================
console.log("\n[14] Field passthrough");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "FullData": {
      open: true,
      address: "1 Real Street, Town",
      phone: "+1 555-0100",
      hours: ["Monday: 9:00 – 17:00", "Tuesday: 9:00 – 17:00"],
      website: "https://realsite.example/",
      lat: 40.0,
      lng: -75.0,
    },
  });
  const ctx = {
    request: makeReq({ venues: [{ name: "FullData", city: "Town" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  const v = body.verifications[0];
  assert("address", v.address === "1 Real Street, Town");
  assert("phone", v.phone === "+1 555-0100");
  assert("hours length 2", Array.isArray(v.hours) && v.hours.length === 2);
  assert("website", v.website === "https://realsite.example/");
  assert("lat", v.lat === 40.0);
  assert("lng", v.lng === -75.0);
  assert("resolved_name set", v.resolved_name === "FullData");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 15: Malformed entries skipped, others processed
// ============================================================
console.log("\n[15] Malformed entries skipped");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "RealOne": { open: true },
  });
  const ctx = {
    request: makeReq({
      venues: [
        null,                              // null
        { city: "X" },                     // no name
        { name: "", city: "X" },           // empty name
        { name: "   ", city: "X" },        // whitespace name
        { name: "RealOne", city: "X" },    // valid
        { name: 42 },                      // wrong type
      ],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("only 1 venue processed", body.verifications.length === 1);
  assert("name RealOne", body.verifications[0].name === "RealOne");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 16: a rejected name match blocks a restaurant but only warns a hotel
// ============================================================
// The name-similarity guard turns "Places answered with something else"
// into not-found. For a restaurant that means the model invented a venue.
// For a hotel it usually means Places picked the wrong property of a real
// chain, so it must not take the export down with it.
console.log("\n[16] Name mismatch is kind-sensitive");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({
    "Marriott London Marble Arch": { resolvesTo: "Marriott Regents Park" },
    "Geronimo": { resolvesTo: "Cafe Pasqual's" },
  });
  const ctx = {
    request: makeReq({
      venues: [
        { name: "Marriott London Marble Arch", city: "London", kind: "hotel" },
        { name: "Geronimo", city: "Santa Fe", kind: "restaurant" },
      ],
    }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const body = await (await onRequestPost(ctx)).json();
  const hotel = body.verifications.find((v) => v.kind === "hotel");
  const rest = body.verifications.find((v) => v.kind === "restaurant");

  assert("hotel mismatch → HOTEL_MATCH_UNCERTAIN",
    hotel.flags.some((f) => f.code === "HOTEL_MATCH_UNCERTAIN"), JSON.stringify(hotel.flags));
  assert("hotel mismatch never blocks",
    !hotel.flags.some((f) => f.severity === "block"), JSON.stringify(hotel.flags));
  assert("hotel mismatch names the property Places actually returned",
    hotel.flags[0].message.includes("Marriott Regents Park"), hotel.flags[0].message);
  assert("restaurant mismatch still blocks as NOT_FOUND",
    rest.flags.some((f) => f.code === "NOT_FOUND" && f.severity === "block"), JSON.stringify(rest.flags));
  assert("the rejected candidate is echoed for the client to score",
    hotel.resolved_name === "Marriott Regents Park", hotel.resolved_name);
  assert("the rejection reason is echoed", hotel.reason === "name-mismatch", hotel.reason);
  assert("summary counts the hotel as a warning, not a block",
    body.summary.blocked === 1 && body.summary.warnings === 1, JSON.stringify(body.summary));
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 17: a hotel Places genuinely cannot find still blocks
// ============================================================
console.log("\n[17] Zero results still blocks a hotel");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({ "Hotel Nonexistent": { notFound: true } });
  const ctx = {
    request: makeReq({ venues: [{ name: "Hotel Nonexistent", city: "Bayeux", kind: "hotel" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const body = await (await onRequestPost(ctx)).json();
  assert("zero matches → NOT_FOUND block even for a hotel",
    body.verifications[0].flags.some((f) => f.code === "NOT_FOUND" && f.severity === "block"),
    JSON.stringify(body.verifications[0].flags));
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 18: a permanently-closed hotel blocks
// ============================================================
console.log("\n[18] Closed hotel blocks");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPlaces({ "Villa Lara": { closed: "CLOSED_PERMANENTLY" } });
  const ctx = {
    request: makeReq({ venues: [{ name: "Villa Lara", city: "Bayeux", kind: "hotel" }] }),
    env: { GOOGLE_PLACES_API_KEY: "k", PLACES: makeKV() },
    waitUntil: (p) => p,
  };
  const body = await (await onRequestPost(ctx)).json();
  assert("business_status still blocks a hotel",
    body.verifications[0].flags.some((f) => f.code === "CLOSED_PERMANENTLY" && f.severity === "block"));
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 19: hotels share the venue cache
// ============================================================
// The API-cost claim for this feature ("+1 Places call per unique hotel")
// only holds if hotels hit the same KV cache as every other venue. The
// cache key is name+city, kind-agnostic — assert that stays true.
console.log("\n[19] Hotels share the name+city cache");
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const inner = mockPlaces({ "Villa Lara": { open: true, address: "6 Place de Quebec" } });
  globalThis.fetch = async (...args) => { calls += 1; return inner(...args); };
  const kv = makeKV();
  const run = async () => {
    const ctx = {
      request: makeReq({ venues: [{ name: "Villa Lara", city: "Bayeux", kind: "hotel" }] }),
      env: { GOOGLE_PLACES_API_KEY: "k", PLACES: kv },
      waitUntil: (p) => p,
    };
    return await (await onRequestPost(ctx)).json();
  };
  await run();
  const firstCalls = calls;
  const second = await run();
  assert("first hotel lookup costs Places calls", firstCalls > 0);
  assert("second lookup of the same hotel costs none", calls === firstCalls, `${calls} vs ${firstCalls}`);
  assert("second lookup is served from cache", second.summary.cache_hits === 1, JSON.stringify(second.summary));
  globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
