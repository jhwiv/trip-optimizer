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

// Map each reviewer source id → query builder + domain filter.
// `q(ctx)` returns the single best query for that source given trip context.
// `domains` scopes Sonar to authoritative URLs only (max 20 per Sonar docs).
// `recency` (optional) restricts to recent results when freshness matters.
const SOURCE_CONFIG = {
  cnt: {
    name: "Condé Nast Traveler",
    domains: ["cntraveler.com"],
    // Keep queries short — Sonar's recall drops sharply when 4+ proper nouns
    // are AND-ed together. We ask for the hot/gold list signal generically and
    // let Sonar rank within the destination + domain scope.
    q: ({ destination }) => `${destination} hotels`,
  },
  tl: {
    name: "Travel + Leisure",
    domains: ["travelandleisure.com"],
    q: ({ destination }) => `${destination} hotels`,
  },
  departures: {
    name: "Departures",
    domains: ["departures.com"],
    q: ({ destination }) => `${destination} luxury`,
  },
  forbes: {
    name: "Forbes Travel Guide",
    domains: ["forbestravelguide.com"],
    q: ({ destination, hotel_name }) => hotel_name ? `${hotel_name}` : `${destination} hotels`,
  },
  michelinK: {
    name: "Michelin Keys",
    domains: ["guide.michelin.com"],
    q: ({ destination, hotel_name }) =>
      hotel_name ? `${hotel_name} Keys` : `${destination} Keys hotels`,
  },
  lqa: {
    name: "LQA / Leading Hotels",
    domains: ["lhw.com"],
    q: ({ destination, hotel_name }) => hotel_name ? `${hotel_name}` : `${destination} hotels`,
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
    q: ({ destination }) => `${destination}`,
  },
  eater: {
    name: "Eater",
    domains: ["eater.com"],
    q: ({ destination }) => `${destination} best restaurants`,
  },
  nyt36: {
    name: "NYT 36 Hours",
    domains: ["nytimes.com"],
    q: ({ destination }) => `36 hours ${destination}`,
  },
  ftHTSI: {
    name: "FT How to Spend It",
    domains: ["ft.com"],
    q: ({ destination }) => `${destination} travel`,
  },
  reddit: {
    name: "Reddit + locals",
    domains: ["reddit.com"],
    q: ({ destination }) => `${destination} travel`,
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

export async function onRequestPost({ request, env }) {
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

  await Promise.all(
    queries.map(async (q) => {
      try {
        const results = await searchOne(q, env.PERPLEXITY_API_KEY, totalAbort.signal);
        snippets.push({
          source_id: q.source_id,
          source_name: q.source_name,
          query: q.query,
          results,
        });
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
