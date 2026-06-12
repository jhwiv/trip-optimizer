// Pass 4 tests — KV cache, snippet lodging guard, Lake George MI false-positive.
import { onRequestPost } from "../functions/api/find.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function mockReq(body) {
  return new Request("https://x/api/find", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const HAPPY = {
  content: [{ type: "tool_use", name: "submit_find_results", input: {
    restaurants: [{ name: "Test", type: "Restaurant", why: "Test.", contact: {} }],
    activities: [],
  } }],
};

async function callWith(body, env, fetchImpl, context = {}) {
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    const res = await onRequestPost({ request: mockReq(body), env, ...context });
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// In-memory KV mock — implements the get/put surface KV gives us.
function makeKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) || null; },
    async put(key, value /*, opts */) { store.set(key, value); return undefined; },
    _store: store,
  };
}

console.log("=== Pass 4: Lake George MI false-positive guard ===");

// 1. "Lake George, MI" should NOT be matched as curated
{
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.com", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { json } = await callWith(
    { location: "Lake George, MI", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  assert("Lake George, MI falls through to generic (NOT curated)",
    json.local_expert?.source_set === "generic",
    `got source_set=${json.local_expert?.source_set}`);
}

// 2. "Lake George, Michigan" same
{
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.com", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { json } = await callWith(
    { location: "Lake George, Michigan", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  assert("Lake George, Michigan → generic", json.local_expert?.source_set === "generic");
}

// 3. "Lake George, FL" → generic (false-positive guard)
{
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.com", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { json } = await callWith(
    { location: "Lake George, FL", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  assert("Lake George, FL → generic", json.local_expert?.source_set === "generic");
}

// 4. Still matches the legit cases
{
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.com", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  for (const loc of ["Lake George, NY", "Lake George", "lake george, ny", "Bolton Landing", "Bolton Landing, NY", "Lake George, New York"]) {
    const { json } = await callWith(
      { location: loc, mode: "local_expert" },
      { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
      mock,
    );
    assert(`"${loc}" still matches curated`, json.local_expert?.source_set === "curated",
      `got ${json.local_expert?.source_set}`);
  }
}

console.log("\n=== Pass 4: Snippet-level lodging guard ===");

// 5. Snippet with a clearly lodging-focused title gets dropped from grounding
{
  let anthropicBody = null;
  const mock = async (url, opts) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [
        { title: "Best Hotels in Lake George 2026", url: "https://x", snippet: "Top luxury lodging." },
        { title: "Where to Eat in Lake George", url: "https://y", snippet: "The Algonquin and Smith's are excellent." },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    anthropicBody = JSON.parse(opts.body);
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  const userMsg = anthropicBody?.messages?.[0]?.content || "";
  const grounding = (userMsg.match(/Local sources consulted[\s\S]*?"""([\s\S]*)"""/) || [, ""])[1];
  assert("lodging-titled snippet dropped from grounding",
    !grounding.includes("Best Hotels in Lake George 2026"),
    `grounding still contains lodging title: ${grounding.slice(0, 300)}`);
  assert("dining-titled snippet kept in grounding",
    grounding.includes("Where to Eat in Lake George"),
    `grounding missing dining title: ${grounding.slice(0, 300)}`);
}

// 6. Snippet whose BODY mentions a hotel (but title is about dining) is kept
{
  let anthropicBody = null;
  const mock = async (url, opts) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [
        { title: "Best restaurants in Lake George", url: "https://x", snippet: "Trillium at the Sagamore Resort offers fine lakeside dining." },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    anthropicBody = JSON.parse(opts.body);
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  const userMsg = anthropicBody?.messages?.[0]?.content || "";
  assert("snippet body mentioning hotel-with-restaurant kept (dining-titled)",
    userMsg.includes("Trillium at the Sagamore Resort"));
}

// 7. All snippets are lodging → no grounding block at all (kept=0 path)
{
  let anthropicBody = null;
  const mock = async (url, opts) => {
    if (url.includes("perplexity.ai")) {
      return new Response(JSON.stringify({ results: [
        { title: "Best Hotels in Lake George", url: "https://x", snippet: "Luxury stays." },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    anthropicBody = JSON.parse(opts.body);
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };
  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  const userMsg = anthropicBody?.messages?.[0]?.content || "";
  assert("when all snippets are lodging, NO grounding block is sent",
    !/Local sources consulted/i.test(userMsg),
    `unexpected grounding block: ${userMsg.slice(0, 300)}`);
}

console.log("\n=== Pass 4: KV cache ===");

// 8. First call writes to KV; second call hits cache, skips Sonar
{
  const kv = makeKV();
  let sonarCalls = 0;
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      sonarCalls++;
      return new Response(JSON.stringify({ results: [{ title: "Where to Eat in Lake George", url: "https://e.com", snippet: "Try the Algonquin." }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };

  // First call — populates cache
  const { json: j1 } = await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p", JOBS: kv },
    mock,
  );
  const firstSonarCalls = sonarCalls;
  assert("first call fires Sonar for each source (6)", firstSonarCalls === 6, `got ${firstSonarCalls}`);
  assert("first call: cache_hits=0", j1.local_expert?.cache_hits === 0);
  assert("first call: cache_total=6", j1.local_expert?.cache_total === 6);
  // Wait briefly for waitUntil-style fire-and-forget writes to land in our in-memory KV
  await new Promise(r => setTimeout(r, 50));
  assert("KV populated after first call", kv._store.size === 6, `KV size = ${kv._store.size}`);

  // Second call — should hit cache entirely
  sonarCalls = 0;
  const { json: j2 } = await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p", JOBS: kv },
    mock,
  );
  assert("second call: zero Sonar calls", sonarCalls === 0, `got ${sonarCalls}`);
  assert("second call: cache_hits=6", j2.local_expert?.cache_hits === 6, `got ${j2.local_expert?.cache_hits}`);
  assert("second call: still ok status", j2.local_expert?.status === "ok");
  assert("second call: sources still populated", (j2.local_expert?.sources?.length || 0) === 6);
  assert("second call: cached=true on each source", j2.local_expert?.sources?.every(s => s.cached === true));
}

// 9. Different query (different location) → cache miss
{
  const kv = makeKV();
  let sonarCalls = 0;
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      sonarCalls++;
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.com", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };

  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p", JOBS: kv },
    mock,
  );
  const lakeGeorgeCalls = sonarCalls;
  sonarCalls = 0;

  // Now Bend, OR — different queries, different cache keys
  await callWith(
    { location: "Bend, OR", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p", JOBS: kv },
    mock,
  );
  assert("different location → cache miss, fresh Sonar calls", sonarCalls === 5,
    `expected 5 Sonar calls for Bend (5 generic sources), got ${sonarCalls}`);
}

// 10. Empty Sonar response → NOT cached (we retry next time)
{
  const kv = makeKV();
  let sonarCalls = 0;
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      sonarCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };

  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p", JOBS: kv },
    mock,
  );
  await new Promise(r => setTimeout(r, 50));
  assert("empty Sonar response → NOT cached", kv._store.size === 0,
    `KV had ${kv._store.size} entries; should be 0 because writes refuse empties`);
}

// 11. Sonar error → NOT cached (we retry next time)
{
  const kv = makeKV();
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) return new Response("server error", { status: 500 });
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };

  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p", JOBS: kv },
    mock,
  );
  await new Promise(r => setTimeout(r, 50));
  assert("Sonar error → NOT cached", kv._store.size === 0,
    `KV had ${kv._store.size} entries; should be 0 because errors aren't cached`);
}

// 12. Cache works even WITHOUT JOBS binding (graceful degrade)
{
  let sonarCalls = 0;
  const mock = async (url) => {
    if (url.includes("perplexity.ai")) {
      sonarCalls++;
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.com", snippet: "S" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(HAPPY), { status: 200, headers: { "content-type": "application/json" } });
  };

  // Two calls with no KV binding — both should fire Sonar (no cache available)
  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" /* no JOBS */ },
    mock,
  );
  const first = sonarCalls;
  await callWith(
    { location: "Lake George, NY", mode: "local_expert" },
    { ANTHROPIC_API_KEY: "k", PERPLEXITY_API_KEY: "p" },
    mock,
  );
  assert("no KV binding: both calls fire Sonar (no caching), no crash",
    sonarCalls === first * 2,
    `first=${first} total=${sonarCalls}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
