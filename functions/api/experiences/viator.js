// Viator (Tripadvisor Experiences) adapter — Basic Access Affiliate API.
//
// Docs: https://docs.viator.com/partner-api/
// Resource center: https://partnerresources.viator.com/
//
// Basic Access endpoints we use here (no approval required, instant self-serve key):
//   POST /partner/products/search                — product summaries
//   GET  /partner/v1/taxonomy/destinations       — destinations
//   GET  /partner/products/tags                  — categories
//
// We do NOT call /booking/* — Basic Access redirects the user to viator.com for
// checkout. When the account is upgraded to Full + Booking, swap the booking
// flow in. The product-search payload is the same.
//
// Env:
//   VIATOR_API_KEY        Required. Generated in the affiliate dashboard.
//   VIATOR_PARTNER_ID     Optional. Used in withAffiliate() to tag the deep link.
//   VIATOR_SUB_ID         Optional. Per-page/per-trip sub-ID for analytics.
//
// Soft-fail: if VIATOR_API_KEY is missing, this adapter returns an empty array
// and logs a warning. The aggregator handles partial-provider failure.

import {
  fetchWithTimeout, priceTier, toUsd, withAffiliate,
} from "./_shared.js";

const VIATOR_BASE = "https://api.viator.com/partner";
const TIMEOUT_MS = 9000;

/**
 * Search Viator products for a destination.
 *
 * @param {Object} args
 * @param {string} args.destination        Free-text destination, e.g. "Lisbon"
 * @param {string[]} [args.interests]      Optional interest tags from the trip form
 * @param {string} [args.startDate]        ISO date (YYYY-MM-DD) for availability filter
 * @param {string} [args.endDate]
 * @param {number} [args.maxPriceUsd]
 * @param {number} [args.limit]            Max products to return (cap 30)
 * @param {Object} env                     Cloudflare Pages env
 * @returns {Promise<{results: import("./_shared.js").Experience[], debug: Object}>}
 */
export async function viatorSearch(args, env) {
  const debug = { provider: "viator", queried: false, destId: null, count: 0, error: null };

  if (!env.VIATOR_API_KEY) {
    debug.error = "VIATOR_API_KEY not set";
    return { results: [], debug };
  }

  // Step 1: resolve destination text → Viator destinationId.
  let destId;
  try {
    destId = await resolveDestinationId(args.destination, env);
    debug.destId = destId;
  } catch (err) {
    debug.error = `destination resolve failed: ${err?.message || err}`;
    return { results: [], debug };
  }
  if (!destId) {
    debug.error = `no Viator destination match for "${args.destination}"`;
    return { results: [], debug };
  }

  // Step 2: search products in that destination.
  const limit = Math.min(args.limit || 12, 30);
  const body = {
    filtering: {
      destination: String(destId),
      ...(args.startDate && args.endDate
        ? { startDate: args.startDate, endDate: args.endDate }
        : {}),
      ...(Number.isFinite(args.maxPriceUsd)
        ? { lowestPrice: { from: 0, to: args.maxPriceUsd } }
        : {}),
    },
    sorting: { sort: "TRAVELER_RATING", order: "DESCENDING" },
    pagination: { start: 1, count: limit },
    currency: "USD",
  };

  let data;
  try {
    const res = await fetchWithTimeout(
      `${VIATOR_BASE}/products/search`,
      {
        method: "POST",
        headers: {
          "Accept-Language": "en-US",
          "Content-Type": "application/json",
          "Accept": "application/json;version=2.0",
          "exp-api-key": env.VIATOR_API_KEY,
        },
        body: JSON.stringify(body),
      },
      TIMEOUT_MS,
    );
    debug.queried = true;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      debug.error = `Viator ${res.status}: ${text.slice(0, 200)}`;
      return { results: [], debug };
    }
    data = await res.json();
  } catch (err) {
    debug.error = `fetch failed: ${err?.message || err}`;
    return { results: [], debug };
  }

  const products = Array.isArray(data?.products) ? data.products : [];
  const results = products
    .map((p) => normalizeViatorProduct(p, env))
    .filter(Boolean);

  debug.count = results.length;
  return { results, debug };
}

/**
 * Map a Viator product (Basic Access shape) to our normalized Experience.
 */
function normalizeViatorProduct(p, env) {
  if (!p || !p.productCode) return null;

  const price = p.pricing?.summary?.fromPrice;
  const currency = p.pricing?.currency || "USD";
  const priceUsd = currency === "USD" ? price : toUsd(price, currency);

  const baseUrl = p.productUrl || `https://www.viator.com/tours/${p.productCode}`;
  const url = withAffiliate("viator", baseUrl, env);

  // Viator returns images as { variants: [{ url, width, height }] }. Pick a mid
  // size for the thumbnail and keep the rest in the images array.
  const images = (p.images || []).flatMap((img) => {
    const variants = Array.isArray(img.variants) ? img.variants : [];
    return variants.map((v) => v.url).filter(Boolean);
  });
  const thumbnail = images[0];

  const durationMinutes = p.duration?.fixedDurationInMinutes
    || p.duration?.variableDurationFromMinutes
    || undefined;

  return {
    id: `viator:${p.productCode}`,
    provider: "viator",
    name: p.title || "",
    url,
    destination: p.destinations?.[0]?.ref || undefined,
    summary: p.description ? truncate(p.description, 220) : undefined,
    description: p.description,
    categories: extractCategories(p),
    thumbnail,
    images: images.slice(0, 6),
    rating: p.reviews?.combinedAverageRating || undefined,
    reviewCount: p.reviews?.totalReviews || undefined,
    priceFromUsd: Number.isFinite(priceUsd) ? priceUsd : undefined,
    currency,
    durationMinutes,
    tier: priceTier(priceUsd),
    skipTheLine: Boolean(p.flags?.includes?.("SKIP_THE_LINE")),
    privateTour: Boolean(p.flags?.includes?.("PRIVATE_TOUR")),
    bookingMode: "redirect",
    highlights: (p.highlights || []).slice(0, 5),
    raw: undefined, // omit to keep responses small; flip on for debugging
  };
}

function extractCategories(p) {
  const cats = [];
  if (Array.isArray(p.tags)) {
    for (const tag of p.tags) {
      if (typeof tag === "string") cats.push(tag.toLowerCase());
      else if (tag?.name) cats.push(String(tag.name).toLowerCase());
    }
  }
  if (Array.isArray(p.categories)) {
    for (const c of p.categories) {
      if (c?.groupId) cats.push(String(c.groupId).toLowerCase());
    }
  }
  return Array.from(new Set(cats)).slice(0, 8);
}

function truncate(s, n) {
  const str = String(s || "");
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Destination resolution (cached in module scope; warm Workers reuse it).
// ---------------------------------------------------------------------------
//
// /v1/taxonomy/destinations returns ~3000 records. We pull once per cold
// start and keep a name → id map in memory. KV would be a nice addition later
// for cross-instance cache, but in-memory is fine for now: a cold start adds
// ~500ms and only on the first request after deploy.

let _destCache = null;
let _destCacheAt = 0;
const DEST_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function loadDestinations(env) {
  const now = Date.now();
  if (_destCache && now - _destCacheAt < DEST_TTL_MS) return _destCache;
  const res = await fetchWithTimeout(
    `${VIATOR_BASE}/v1/taxonomy/destinations`,
    {
      headers: {
        "Accept-Language": "en-US",
        "Accept": "application/json;version=2.0",
        "exp-api-key": env.VIATOR_API_KEY,
      },
    },
    TIMEOUT_MS,
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`taxonomy ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : [];
  _destCache = list;
  _destCacheAt = now;
  return list;
}

async function resolveDestinationId(query, env) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  const list = await loadDestinations(env);

  // Prefer exact city match, then prefix, then substring.
  let exact, prefix, sub;
  for (const d of list) {
    const name = String(d.name || "").toLowerCase();
    if (!name) continue;
    if (name === q) { exact = d; break; }
    if (!prefix && name.startsWith(q)) prefix = d;
    if (!sub && name.includes(q)) sub = d;
  }
  const hit = exact || prefix || sub;
  return hit?.destinationId || hit?.ref || null;
}
