// POST /api/review-retrieve
//
// Server-side retrieval step that runs BEFORE the Anthropic review call.
// Hits Perplexity's Sonar /search API in parallel — one query per selected
// reviewer source, each scoped to that source's authoritative domains — and
// returns a compact set of real, current URLs + snippets the review prompt
// can ground its findings in.
//
// Why this exists:
//   The review LLM otherwise reasons from training data, which goes stale
//   fast — restaurants close, Michelin stars move, hot lists update. By
//   front-loading 3–5 real results per source we surface "is this hotel
//   still on the Michelin Keys list?" / "is this restaurant in the current
//   NYT 36 Hours piece?" — the questions the panel is supposed to answer.
//
// Body:
//   {
//     destination: string,                     // "Aspen, CO"
//     hotel_name?: string,                     // "The Little Nell"
//     restaurants?: string[],                  // top ~6 restaurant names
//     activities?: string[],                   // top ~4 activity names
//     sources: string[]                        // REVIEWER_SOURCES ids to query
//   }
//
// Returns:
//   {
//     snippets: [{ source_id, source_name, query, results: [{title, url, snippet, date}] }],
//     errors:   [{ source_id, message }],      // best-effort; partial success OK
//     elapsed_ms: number
//   }
//
// Auth: env.PERPLEXITY_API_KEY (Cloudflare Pages secret).
//
// If the key is missing or every source errors out, we return 200 with an
// empty snippets array + populated errors[] so the client can fall back
// gracefully ("Live sources unavailable — using training data.").

const SONAR_URL = "https://api.perplexity.ai/search";
const PER_SOURCE_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 15000;
const MAX_RESULTS_PER_QUERY = 3;

// ---- KV response cache for Sonar lookups --------------------------------
// Each /api/review-retrieve fans out up to 7 paid Sonar calls in parallel,
// each 1–2 seconds and a non-trivial line item per call. Cache results so
// re-running review on the same trip (very common while iterating on a
// build) or running review on a different trip with the same destination
// returns instantly with zero Sonar spend.
//
// Cache key: rev:v1:<sha256-of-source_id+query>
//   The query string already incorporates destination, hotel_name, and the
//   first restaurant (see SOURCE_CONFIG). Domains and recency are static
//   per source. So identical (source_id, query) tuples always hit.
//
// TTL: 2 hours. Travel-press results genuinely DO move (Michelin updates,
// hotels close, hot lists rotate) so 30 days would serve stale content;
// 2h captures the common case (re-runs and same-day work) without ever
// returning a result more than a couple of hours old.
const REVIEW_CACHE_VERSION = "v1"; // bump when SOURCE_CONFIG queries change shape
const REVIEW_CACHE_TTL = 60 * 60 * 2; // 2 hours

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function cacheKeyFor(source_id, query) {
  const hash = await sha256Hex(`${source_id}\u0000${query}`);
  return `rev:${REVIEW_CACHE_VERSION}:${hash}`;
}

async function readCache(env, key) {
  if (!env?.JOBS) return null;
  try {
    const raw = await env.JOBS.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.results)) return parsed.results;
    return null;
  } catch {
    return null;
  }
}

function writeCache(env, key, results, ctx) {
  if (!env?.JOBS) return;
  // Don't cache empty result sets — they're usually transient (Sonar quota,
  // domain block, etc.) and we want the next call to actually retry.
  if (!Array.isArray(results) || results.length === 0) return;
  const p = env.JOBS.put(key, JSON.stringify({ results }), {
    expirationTtl: REVIEW_CACHE_TTL,
  }).catch(() => { /* swallow — a failed write is never worth blocking on */ });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

// Map each reviewer source id → query builder + domain filter.
// `q(ctx)` returns the single best query for that source given trip context.
// `domains` scopes Sonar to authoritative URLs only (max 20 per Sonar docs).
// `recency` (optional) restricts to recent results when freshness matters.
const SOURCE_CONFIG = {
  // Editorial — broad travel-press net. Sonar's index of cntraveler.com alone
  // is sparse; pooling 3 peer publications gets us reliable hits.
  cnt: {
    name: "Condé Nast Traveler",
    domains: ["cntraveler.com", "travelandleisure.com", "afar.com"],
    q: ({ destination }) => `${destination} hotels guide`,
  },
  tl: {
    name: "Travel + Leisure",
    domains: ["travelandleisure.com", "afar.com"],
    q: ({ destination }) => `${destination} hotels`,
  },
  departures: {
    name: "Departures",
    domains: ["departures.com", "robbreport.com"],
    q: ({ destination }) => `${destination} luxury hotels`,
  },
  forbes: {
    name: "Forbes Travel Guide",
    domains: ["forbestravelguide.com", "forbes.com"],
    q: ({ destination, hotel_name }) =>
      hotel_name ? `${hotel_name} hotel rating` : `${destination} luxury hotels`,
  },
  michelinK: {
    name: "Michelin Keys",
    domains: ["guide.michelin.com"],
    q: ({ destination, hotel_name }) =>
      hotel_name ? `${hotel_name} hotel` : `${destination} hotels keys`,
  },
  lqa: {
    name: "LQA / Leading Hotels",
    domains: ["lhw.com", "lqa.com"],
    q: ({ destination, hotel_name }) =>
      hotel_name ? `${hotel_name}` : `${destination} leading hotels`,
  },
  michelinG: {
    name: "Michelin Guide",
    domains: ["guide.michelin.com"],
    q: ({ destination, restaurants }) => {
      const r = (restaurants && restaurants[0]) || "";
      return r ? `${r} ${destination}` : `${destination} restaurants`;
    },
  },
  w50b: {
    name: "World's 50 Best",
    domains: ["theworlds50best.com"],
    q: ({ destination }) => `${destination} best restaurants`,
  },
  // Eater publishes hyper-local; keep scope narrow on this one.
  eater: {
    name: "Eater",
    domains: ["eater.com"],
    q: ({ destination }) => `${destination} essential restaurants`,
  },
  // NYT 36 Hours: nytimes.com is paywalled to Sonar, so widen to travel-press
  // peer outlets that summarize / reference the column.
  nyt36: {
    name: "NYT 36 Hours",
    domains: ["nytimes.com", "afar.com", "travelandleisure.com"],
    q: ({ destination }) => `36 hours ${destination} itinerary`,
  },
  ftHTSI: {
    name: "FT How to Spend It",
    domains: ["ft.com", "howtospendit.ft.com", "robbreport.com"],
    q: ({ destination }) => `${destination} luxury travel`,
  },
  // Reddit blocks most AI crawlers, so Sonar's reddit.com index is thin.
  // Pool reddit + tripadvisor + fodors to recover the "locals + travelers
  // talking to each other" lens.
  reddit: {
    name: "Reddit + locals",
    domains: ["reddit.com", "tripadvisor.com", "fodors.com"],
    q: ({ destination }) => `${destination} trip report tips`,
  },
  // Atlas Obscura: the canonical "off the beaten path" database — unusual
  // landmarks, obscure museums, neighborhood oddities, hidden traditions.
  // No recency filter; the catalog is intentionally timeless (e.g. the
  // Vodnjan mummified saints discovery referenced in our own Croatia plans
  // came directly from this lineage of source).
  atlasObscura: {
    name: "Atlas Obscura",
    domains: ["atlasobscura.com"],
    q: ({ destination }) => `${destination} hidden gems offbeat`,
  },
  // Substack: travel newsletters are where editors who left Conde Nast /
  // T+L now publish their real picks — Black Tomato musings, Carat Letter,
  // Mr & Mrs Smith editors, etc. Recency-filtered because newsletter content
  // dates fast ("opened last month" pieces) and we want fresh signal.
  substack: {
    name: "Substack travel",
    domains: ["substack.com"],
    q: ({ destination }) => `${destination} restaurant hotel guide 2025 2026`,
    recency: "month",
  },
};

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const startedAt = Date.now();

  if (!env.PERPLEXITY_API_KEY) {
    // Soft-fail: return empty snippets so the client can degrade gracefully.
    return json({
      snippets: [],
      errors: [{ source_id: "_config", message: "PERPLEXITY_API_KEY not set on Pages" }],
      elapsed_ms: Date.now() - startedAt,
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const destination = String(body?.destination || "").trim();
  if (!destination) return json({ error: "Missing destination" }, 400);

  const ctx = {
    destination,
    hotel_name: String(body?.hotel_name || "").trim() || null,
    restaurants: Array.isArray(body?.restaurants) ? body.restaurants.slice(0, 6) : [],
    activities: Array.isArray(body?.activities) ? body.activities.slice(0, 4) : [],
  };

  const sourceIds = Array.isArray(body?.sources) ? body.sources : [];
  const queries = sourceIds
    .filter((id) => SOURCE_CONFIG[id])
    .map((id) => {
      const cfg = SOURCE_CONFIG[id];
      return {
        source_id: id,
        source_name: cfg.name,
        query: cfg.q(ctx),
        domains: cfg.domains,
        recency: cfg.recency || null,
      };
    });

  if (queries.length === 0) {
    return json({
      snippets: [],
      errors: [{ source_id: "_config", message: "No valid sources requested" }],
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // Hard cap on total wall-clock so a slow upstream can't hold the build.
  const totalAbort = new AbortController();
  const totalT = setTimeout(() => totalAbort.abort(), TOTAL_TIMEOUT_MS);

  const snippets = [];
  const errors = [];

  let cacheHits = 0;
  await Promise.all(
    queries.map(async (q) => {
      try {
        // Cache lookup first — sub-50ms KV read beats 1–2s Sonar call.
        const key = await cacheKeyFor(q.source_id, q.query);
        const cached = await readCache(env, key);
        if (cached) {
          cacheHits++;
          snippets.push({
            source_id: q.source_id,
            source_name: q.source_name,
            query: q.query,
            results: cached,
            cached: true,
          });
          return;
        }
        const results = await searchOne(q, env.PERPLEXITY_API_KEY, totalAbort.signal);
        snippets.push({
          source_id: q.source_id,
          source_name: q.source_name,
          query: q.query,
          results,
          cached: false,
        });
        // Fire-and-forget cache write so we don't delay the response.
        writeCache(env, key, results, context);
      } catch (err) {
        errors.push({ source_id: q.source_id, message: errMessage(err) });
      }
    }),
  );

  clearTimeout(totalT);

  return json({
    snippets,
    errors,
    elapsed_ms: Date.now() - startedAt,
    cache_hits: cacheHits,
    cache_total: queries.length,
  });
}

async function searchOne(q, apiKey, parentSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_SOURCE_TIMEOUT_MS);
  // Abort if the parent (total) timeout fires.
  const onParentAbort = () => ctrl.abort();
  parentSignal.addEventListener("abort", onParentAbort);

  try {
    const payload = {
      query: q.query,
      max_results: MAX_RESULTS_PER_QUERY,
      max_tokens_per_page: 512,
      search_domain_filter: q.domains.slice(0, 20),
    };
    if (q.recency) payload.search_recency_filter = q.recency;

    const res = await fetch(SONAR_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sonar ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    // Normalize to what the review prompt needs.
    return results.slice(0, MAX_RESULTS_PER_QUERY).map((r) => ({
      title: String(r.title || "").trim(),
      url: String(r.url || "").trim(),
      snippet: String(r.snippet || "").trim().slice(0, 400),
      date: r.date || r.last_updated || null,
    }));
  } finally {
    clearTimeout(t);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

function errMessage(err) {
  const msg = String(err?.message || err);
  if (/abort|timeout/i.test(msg)) return "timeout";
  return msg.slice(0, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
