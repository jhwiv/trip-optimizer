// POST /api/confirm-booking
// ------------------------------------------------------------------
// For each restaurant in the request, ask Perplexity Sonar which
// reservation platform it actually uses (Resy / OpenTable / Tock /
// phone-only / walk-in) and return the canonical reservation URL.
// Also returns the restaurant's official website when discoverable.
//
// Why this exists:
//   The /api/build pipeline asks Claude to guess `reservation.platform`
//   ("opentable for most US/UK/EU fine dining; resy for trendy
//   NYC/LA/Miami; ...") which is a heuristic. About 1 in 5 picks is
//   wrong — a Resy-only spot gets an OpenTable search URL that
//   returns "no results" and the user thinks the restaurant is gone.
//   Sonar grounds the platform to the actual current booking system.
//
// Request body:
//   {
//     restaurants: [
//       { name: string, city?: string, neighborhood?: string }
//     ]
//   }
//   Limit: 30 restaurants per call.
//
// Response (always 200 unless input is malformed):
//   {
//     confirmations: [
//       {
//         name: string,           // echo of input name (used as key by client)
//         platform: "opentable" | "resy" | "tock" | "phone" | "walkin" | "unknown",
//         url: string | null,     // canonical reservation URL when known
//         website: string | null, // restaurant's official site
//         confidence: "high" | "low",
//         source: string | null   // citation URL Sonar returned
//       }
//     ],
//     elapsed_ms: number,
//     cache_hits: number,
//     cache_total: number
//   }
//
// Caching:
//   Per (name, city) key in KV (env.JOBS) for 30 days. Booking platforms
//   change rarely — a restaurant that's on Resy today is overwhelmingly
//   on Resy 30 days from now. 30d TTL covers a typical "plan, refine,
//   refine, refine, book" cycle without re-charging Sonar.
//
// Soft-fail behavior:
//   - Missing PERPLEXITY_API_KEY → returns confirmations with
//     platform=unknown for every entry (and the client falls back to
//     whatever the build pipeline guessed).
//   - Per-restaurant Sonar timeout or error → that entry returns
//     platform=unknown; other entries are unaffected.
//   - Missing KV (env.JOBS) → no caching, fresh Sonar call every time;
//     endpoint still works.

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar"; // online, cheap, ~1-2s
const SONAR_TIMEOUT_MS = 6000;
const MAX_PARALLEL = 6;
const MAX_RESTAURANTS = 30;

const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const RESERVATION_DOMAINS = [
  "resy.com",
  "opentable.com",
  "exploretock.com",
  "tockify.com",
  "sevenrooms.com",
];

const PLATFORM_HINTS = {
  "resy.com": "resy",
  "opentable.com": "opentable",
  "exploretock.com": "tock",
  "tockify.com": "tock",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      ...corsHeaders(),
    },
  });
}

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

async function cacheKeyFor(name, city) {
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const hash = await sha256Hex(`${norm(name)}\u0000${norm(city)}`);
  return `confirm-booking:${CACHE_VERSION}:${hash}`;
}

async function readCache(env, key) {
  if (!env?.JOBS) return null;
  try {
    const raw = await env.JOBS.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.platform === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(env, key, payload, ctx) {
  if (!env?.JOBS) return;
  // Don't cache "unknown" — we want a chance to look it up again later.
  // Sonar transient failure shouldn't poison the cache for 30 days.
  if (!payload || payload.platform === "unknown") return;
  const p = env.JOBS.put(key, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_SECONDS,
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const startedAt = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Invalid JSON in request body" } }, 400);
  }

  const restaurants = Array.isArray(body?.restaurants) ? body.restaurants : [];
  if (restaurants.length === 0) {
    return json({ confirmations: [], elapsed_ms: 0, cache_hits: 0, cache_total: 0 });
  }

  // Sanitize + cap. Dedup by lowercase name+city so the same restaurant
  // listed for dinner and lunch isn't double-charged.
  const seen = new Set();
  const cleaned = [];
  for (const r of restaurants) {
    if (!r || typeof r.name !== "string") continue;
    const name = r.name.trim().slice(0, 120);
    if (!name) continue;
    const city = String(r.city || "").trim().slice(0, 80);
    const neighborhood = String(r.neighborhood || "").trim().slice(0, 80);
    const key = `${name.toLowerCase()}|${city.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ name, city, neighborhood });
    if (cleaned.length >= MAX_RESTAURANTS) break;
  }

  if (cleaned.length === 0) {
    return json({ confirmations: [], elapsed_ms: 0, cache_hits: 0, cache_total: 0 });
  }

  const hasSonar = !!env.PERPLEXITY_API_KEY;
  let cacheHits = 0;

  const results = await mapParallel(cleaned, MAX_PARALLEL, async (entry) => {
    const key = await cacheKeyFor(entry.name, entry.city);
    const cached = await readCache(env, key);
    if (cached) {
      cacheHits += 1;
      return { name: entry.name, ...cached };
    }

    if (!hasSonar) {
      return {
        name: entry.name,
        platform: "unknown",
        url: null,
        website: null,
        confidence: "low",
        source: null,
      };
    }

    try {
      const sonar = await querySonar(env.PERPLEXITY_API_KEY, entry);
      const parsed = parseSonarAnswer(sonar);
      const payload = {
        platform: parsed.platform,
        url: parsed.url,
        website: parsed.website,
        confidence: parsed.confidence,
        source: parsed.source,
      };
      writeCache(env, key, payload, context);
      return { name: entry.name, ...payload };
    } catch {
      return {
        name: entry.name,
        platform: "unknown",
        url: null,
        website: null,
        confidence: "low",
        source: null,
      };
    }
  });

  return json({
    confirmations: results,
    elapsed_ms: Date.now() - startedAt,
    cache_hits: cacheHits,
    cache_total: cleaned.length,
  });
}

// ---- Sonar call ---------------------------------------------------------

async function querySonar(apiKey, entry) {
  const locale = [entry.neighborhood, entry.city].filter(Boolean).join(", ");
  const userMsg =
    `Restaurant: "${entry.name}"${locale ? ` in ${locale}` : ""}.\n\n` +
    `1) What reservation platform does this restaurant currently use? Pick ONE: Resy, OpenTable, Tock, phone-only, or walk-in.\n` +
    `2) What is the direct reservation URL (resy.com/..., opentable.com/r/..., exploretock.com/...)? If phone-only, give the phone number. If walk-in, write "walk-in".\n` +
    `3) What is the restaurant's official website?\n\n` +
    `Respond in this exact JSON shape (no markdown fence, no commentary):\n` +
    `{"platform":"resy|opentable|tock|phone|walkin|unknown","url":"<direct booking URL or phone or empty>","website":"<official site URL or empty>","confidence":"high|low"}`;

  const payload = {
    model: SONAR_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a restaurant-booking lookup assistant. Return only the JSON object requested — no markdown, no preface. If you can't confidently determine the platform, return platform=unknown with confidence=low. Never invent a URL: if you don't know the canonical URL, leave url empty.",
      },
      { role: "user", content: userMsg },
    ],
    search_domain_filter: RESERVATION_DOMAINS,
    max_tokens: 300,
    temperature: 0,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SONAR_TIMEOUT_MS);
  try {
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
    const content = data?.choices?.[0]?.message?.content || "";
    const citations = Array.isArray(data?.citations) ? data.citations : [];
    return { content, citations };
  } finally {
    clearTimeout(t);
  }
}

// ---- Response parsing ---------------------------------------------------

function parseSonarAnswer({ content, citations }) {
  // Sonar usually obeys the JSON-only directive, but sometimes wraps it in
  // a ```json fence or trails commentary. Strip the fence and grab the
  // first {...} block.
  const text = String(content || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonStr = objMatch ? objMatch[0] : candidate;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return inferFromCitations(citations);
  }

  let platform = String(parsed.platform || "").toLowerCase().trim();
  const allowed = new Set(["resy", "opentable", "tock", "phone", "walkin", "unknown"]);
  if (!allowed.has(platform)) {
    // Common Sonar variants — coerce them.
    if (platform === "phone-only" || platform === "phoneonly") platform = "phone";
    else if (platform === "walk-in" || platform === "walk in") platform = "walkin";
    else platform = "unknown";
  }

  let url = sanitizeUrl(parsed.url);
  const website = sanitizeUrl(parsed.website);
  let confidence = parsed.confidence === "high" ? "high" : "low";

  // If Sonar claims a platform but its URL doesn't match that platform's
  // domain, trust the URL — domain match is harder to fake than a free-
  // text platform name. Resy/OpenTable/Tock domains are distinctive.
  if (url) {
    const hint = domainHint(url);
    if (hint && hint !== platform && platform !== "phone") {
      platform = hint;
      confidence = "high";
    }
  }

  // If platform is opentable/resy/tock but URL is missing, downgrade
  // confidence. The user can still tap the search URL the client builds
  // as a fallback, but we shouldn't pretend we know the canonical link.
  if (!url && ["opentable", "resy", "tock"].includes(platform)) {
    confidence = "low";
  }

  // Phone-only: keep the phone number in url so the client can render
  // a tel: link. Normalize to digits + leading "+".
  if (platform === "phone" && url) {
    const phoneMatch = url.match(/[\d+()\-\s.]{7,}/);
    url = phoneMatch ? phoneMatch[0].trim() : url;
  }

  // Walk-in: url is meaningless — clear it.
  if (platform === "walkin") url = null;

  const source = citations[0] || null;
  return { platform, url, website, confidence, source };
}

function inferFromCitations(citations) {
  // JSON parse failed — last-resort: scan citations for a known platform
  // domain. This catches the "Sonar returned just a URL with prose" case.
  for (const c of citations || []) {
    const hint = domainHint(c);
    if (hint) {
      return {
        platform: hint,
        url: c,
        website: null,
        confidence: "low",
        source: c,
      };
    }
  }
  return {
    platform: "unknown",
    url: null,
    website: null,
    confidence: "low",
    source: null,
  };
}

function sanitizeUrl(raw) {
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!u) return null;
  // Phone numbers: return as-is — parser distinguishes by platform.
  if (/^\+?[\d()\-\s.]{7,}$/.test(u)) return u;
  // Strict scheme check: must START with http:// or https:// (case-insensitive).
  // Rejects data:, javascript:, file:, mailto:, etc. — even if dressed up with
  // whitespace or odd casing.
  if (!/^https?:\/\//i.test(u)) return null;
  if (u.length > 500) return null;
  // Final validation: must parse as a URL with an http(s) protocol.
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return u;
}

function domainHint(url) {
  if (typeof url !== "string") return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    for (const [dom, plat] of Object.entries(PLATFORM_HINTS)) {
      if (host === dom || host.endsWith("." + dom)) return plat;
    }
  } catch {
    return null;
  }
  return null;
}

// ---- Concurrency --------------------------------------------------------

async function mapParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        results[idx] = {
          name: items[idx]?.name || "",
          platform: "unknown",
          url: null,
          website: null,
          confidence: "low",
          source: null,
        };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
