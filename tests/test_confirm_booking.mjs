// Tests for functions/api/confirm-booking.js — pure unit tests with mocked
// fetch and an in-memory KV stand-in. No network, no Cloudflare runtime.

import { onRequestPost } from "../functions/api/confirm-booking.js";

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

// ---- Mock Sonar response factory -----------------------------------------
function sonarResp({ content, citations = [] }) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    citations,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ---- Request helper -----------------------------------------------------
function makeReq(body) {
  return new Request("http://localhost/api/confirm-booking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ============================================================
// Test 1: malformed JSON → 400
// ============================================================
console.log("\n[1] Malformed JSON");
{
  const ctx = {
    request: new Request("http://localhost/api/confirm-booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
    env: {},
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  assert("returns 400", res.status === 400);
}

// ============================================================
// Test 2: empty restaurants → 200 with empty confirmations
// ============================================================
console.log("\n[2] Empty input");
{
  const ctx = { request: makeReq({ restaurants: [] }), env: {}, waitUntil: () => {} };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("empty confirmations", Array.isArray(body.confirmations) && body.confirmations.length === 0);
  assert("cache_total 0", body.cache_total === 0);
}

// ============================================================
// Test 3: no PERPLEXITY_API_KEY → unknown for every entry
// ============================================================
console.log("\n[3] Missing PERPLEXITY_API_KEY → soft fail");
{
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Le Bernardin", city: "New York" }] }),
    env: { JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("1 confirmation", body.confirmations.length === 1);
  assert("platform unknown", body.confirmations[0].platform === "unknown");
  assert("no url", body.confirmations[0].url === null);
}

// ============================================================
// Test 4: Sonar returns clean Resy JSON → parsed correctly
// ============================================================
console.log("\n[4] Sonar returns Resy JSON");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "https://api.perplexity.ai/chat/completions") {
      return sonarResp({
        content: '{"platform":"resy","url":"https://resy.com/cities/ny/the-compound","website":"https://thecompound.com","confidence":"high"}',
        citations: ["https://resy.com/cities/ny/the-compound"],
      });
    }
    throw new Error("Unexpected fetch: " + url);
  };

  const kv = makeKV();
  const ctx = {
    request: makeReq({ restaurants: [{ name: "The Compound", city: "Santa Fe" }] }),
    env: { PERPLEXITY_API_KEY: "test-key", JOBS: kv },
    waitUntil: (p) => p,
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("platform resy", body.confirmations[0].platform === "resy");
  assert("url matches", body.confirmations[0].url === "https://resy.com/cities/ny/the-compound");
  assert("website set", body.confirmations[0].website === "https://thecompound.com");
  assert("confidence high", body.confirmations[0].confidence === "high");
  // Wait for cache write
  await new Promise(r => setTimeout(r, 50));
  assert("cached", kv._store.size === 1);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 5: Sonar wraps response in ```json fence → still parsed
// ============================================================
console.log("\n[5] Markdown-fenced JSON");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: '```json\n{"platform":"opentable","url":"https://www.opentable.com/r/luminaria-santa-fe","website":"","confidence":"high"}\n```',
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Luminaria", city: "Santa Fe" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("platform opentable", body.confirmations[0].platform === "opentable");
  assert("url opentable", body.confirmations[0].url?.includes("opentable.com"));
  assert("website null (empty string)", body.confirmations[0].website === null);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 6: Sonar claims OpenTable but URL is Resy → coerce to Resy
// ============================================================
console.log("\n[6] Domain-based platform coercion");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: '{"platform":"opentable","url":"https://resy.com/cities/ny/per-se","website":"","confidence":"low"}',
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Per Se", city: "New York" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("coerced to resy", body.confirmations[0].platform === "resy", `got ${body.confirmations[0].platform}`);
  assert("confidence upgraded to high", body.confirmations[0].confidence === "high");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 7: Walk-in platform → url cleared
// ============================================================
console.log("\n[7] Walk-in clears URL");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: '{"platform":"walk-in","url":"walk-in","website":"https://shake.com","confidence":"high"}',
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Shake Shack", city: "Anywhere" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("platform walkin", body.confirmations[0].platform === "walkin");
  assert("url null", body.confirmations[0].url === null);
  assert("website preserved", body.confirmations[0].website === "https://shake.com");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 8: phone-only normalization
// ============================================================
console.log("\n[8] Phone-only normalization");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: '{"platform":"phone-only","url":"(505) 982-1500","website":"https://geronimo.com","confidence":"high"}',
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Geronimo", city: "Santa Fe" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("platform phone", body.confirmations[0].platform === "phone");
  assert("phone preserved", body.confirmations[0].url === "(505) 982-1500");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 9: Sonar timeout → unknown
// ============================================================
console.log("\n[9] Sonar timeout → unknown");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  };
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Slow Spot", city: "Nowhere" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  // Speed test: don't actually wait 6s — Sonar timeout is 6000ms in real code.
  // We rely on the AbortController being honored. Let's set a smaller window:
  const start = Date.now();
  // We need to actually drive the abort. Override SONAR_TIMEOUT_MS isn't
  // possible without reimporting; instead, let our fetch reject immediately.
  globalThis.fetch = async () => { throw new Error("immediate failure"); };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("platform unknown", body.confirmations[0].platform === "unknown");
  assert("returned quickly", Date.now() - start < 1000);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 10: Dedup — same restaurant twice → one confirmation
// ============================================================
console.log("\n[10] Dedup");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return sonarResp({ content: '{"platform":"resy","url":"https://resy.com/x","website":"","confidence":"high"}' });
  };
  const ctx = {
    request: makeReq({
      restaurants: [
        { name: "Place A", city: "City" },
        { name: "Place A", city: "City" }, // duplicate
        { name: "place a", city: "city" }, // case variant
      ],
    }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("1 confirmation (deduped)", body.confirmations.length === 1, `got ${body.confirmations.length}`);
  assert("1 Sonar call", callCount === 1, `got ${callCount}`);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 11: Cache hit on second call
// ============================================================
console.log("\n[11] Cache hit");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return sonarResp({ content: '{"platform":"resy","url":"https://resy.com/x","website":"https://x.com","confidence":"high"}' });
  };
  const kv = makeKV();

  // First call — cache miss
  const ctx1 = {
    request: makeReq({ restaurants: [{ name: "Cached Spot", city: "Town" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: kv },
    waitUntil: (p) => p,
  };
  await (await onRequestPost(ctx1)).json();
  // Wait for fire-and-forget cache write
  await new Promise(r => setTimeout(r, 50));

  // Second call — should hit cache
  const ctx2 = {
    request: makeReq({ restaurants: [{ name: "Cached Spot", city: "Town" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: kv },
    waitUntil: (p) => p,
  };
  const res2 = await onRequestPost(ctx2);
  const body2 = await res2.json();
  assert("only 1 Sonar call (cache hit)", callCount === 1, `got ${callCount}`);
  assert("cache_hits=1", body2.cache_hits === 1);
  assert("returns same platform", body2.confirmations[0].platform === "resy");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 12: Cap at MAX_RESTAURANTS (30)
// ============================================================
console.log("\n[12] Cap at 30");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({ content: '{"platform":"unknown","url":"","website":"","confidence":"low"}' });
  const restaurants = Array.from({ length: 50 }, (_, i) => ({ name: `R${i}`, city: "X" }));
  const ctx = {
    request: makeReq({ restaurants }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("capped at 30", body.confirmations.length === 30);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 13: Garbage JSON from Sonar → inferFromCitations fallback
// ============================================================
console.log("\n[13] Garbage response → citation fallback");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: "I think it's on Resy but I'm not totally sure.",
    citations: ["https://resy.com/cities/ny/some-restaurant"],
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Garbled", city: "City" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("inferred resy from citation", body.confirmations[0].platform === "resy");
  assert("url from citation", body.confirmations[0].url?.includes("resy.com"));
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 14: Garbage JSON with no useful citations → unknown
// ============================================================
console.log("\n[14] Garbage with no useful citations → unknown");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: "Sorry, I don't have information about that restaurant.",
    citations: ["https://wikipedia.org/something"],
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "Unknown Spot", city: "City" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("platform unknown", body.confirmations[0].platform === "unknown");
  assert("url null", body.confirmations[0].url === null);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 15: 'unknown' is NOT cached
// ============================================================
console.log("\n[15] Unknowns are not cached");
{
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return sonarResp({ content: '{"platform":"unknown","url":"","website":"","confidence":"low"}' });
  };
  const kv = makeKV();
  const baseCtx = (waitUntil) => ({
    env: { PERPLEXITY_API_KEY: "k", JOBS: kv },
    waitUntil,
  });
  await (await onRequestPost({ ...baseCtx(p => p), request: makeReq({ restaurants: [{ name: "X", city: "Y" }] }) })).json();
  await new Promise(r => setTimeout(r, 50));
  await (await onRequestPost({ ...baseCtx(p => p), request: makeReq({ restaurants: [{ name: "X", city: "Y" }] }) })).json();
  assert("re-queried (no negative cache)", callCount === 2, `got ${callCount}`);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 16: Sonar 5xx error → unknown, doesn't poison cache
// ============================================================
console.log("\n[16] Sonar 5xx → graceful unknown");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream error", { status: 502 });
  const kv = makeKV();
  const ctx = {
    request: makeReq({ restaurants: [{ name: "X", city: "Y" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: kv },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200 (soft fail)", res.status === 200);
  assert("platform unknown", body.confirmations[0].platform === "unknown");
  assert("cache not poisoned", kv._store.size === 0);
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 17: Missing KV (env.JOBS undefined) — endpoint still works
// ============================================================
console.log("\n[17] Missing KV doesn't break endpoint");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: '{"platform":"resy","url":"https://resy.com/x","website":"","confidence":"high"}',
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "X", city: "Y" }] }),
    env: { PERPLEXITY_API_KEY: "k" }, // no JOBS
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("status 200", res.status === 200);
  assert("platform resy", body.confirmations[0].platform === "resy");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Test 18: Malicious URL schemes rejected
// ============================================================
console.log("\n[18] Malicious URLs rejected");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sonarResp({
    content: '{"platform":"resy","url":"javascript:alert(1)","website":"data:text/html,<script>1</script>","confidence":"high"}',
  });
  const ctx = {
    request: makeReq({ restaurants: [{ name: "X", city: "Y" }] }),
    env: { PERPLEXITY_API_KEY: "k", JOBS: makeKV() },
    waitUntil: () => {},
  };
  const res = await onRequestPost(ctx);
  const body = await res.json();
  assert("javascript: url stripped", body.confirmations[0].url === null);
  assert("data: website stripped", body.confirmations[0].website === null);
  // platform should be downgraded since url is missing
  assert("confidence downgraded", body.confirmations[0].confidence === "low");
  globalThis.fetch = originalFetch;
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
