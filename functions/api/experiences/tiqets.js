// Tiqets Distributor / Partner API adapter.
//
// Docs: https://developers.tiqets.dev
// Affiliate self-service tokens: Tools → API Access in the affiliate portal.
//
// Tiqets is strongest for museum / attraction skip-the-line tickets — the
// "Skip the Vatican line" / "Last-minute Uffizi at 4pm" use case. We surface
// them as their own provider so the ranker can prefer them when the user's
// itinerary calls for a museum or attraction slot.
//
// Endpoints (current public shape; field names may evolve — keep an eye on
// developers.tiqets.dev):
//   GET /v2/products  ?q=...&country=...&city=...&page_size=...
//   GET /v2/products/{slug}
//
// Auth: Bearer token in Authorization header.
// Image access is gated — request activation from the account team if images
// come back missing. The adapter tolerates either case.
//
// Env:
//   TIQETS_API_TOKEN      Required to go live. Without it, returns [].
//   TIQETS_PARTNER_ID     Optional. Appended to deep links via withAffiliate().

import {
  fetchWithTimeout, priceTier, toUsd, withAffiliate, fuzzyScore,
} from "./_shared.js";

const TIQETS_BASE = "https://api.tiqets.com/v2";
const TIMEOUT_MS = 8000;

/**
 * @param {Object} args
 * @param {string} args.destination
 * @param {string[]} [args.interests]
 * @param {number} [args.limit]
 * @param {Object} env
 */
export async function tiqetsSearch(args, env) {
  const debug = { provider: "tiqets", queried: false, count: 0, error: null };

  if (!env.TIQETS_API_TOKEN) {
    debug.error = "TIQETS_API_TOKEN not set";
    return { results: [], debug };
  }

  const params = new URLSearchParams();
  params.set("q", args.destination || "");
  params.set("page_size", String(Math.min(args.limit || 12, 30)));
  // Tiqets's catalogue is city-indexed; the `q` text search matches both city
  // and product names. The aggregator filters by destination after the fact
  // using fuzzyScore() against the result city tags as well.

  let data;
  try {
    const res = await fetchWithTimeout(
      `${TIQETS_BASE}/products?${params.toString()}`,
      {
        headers: {
          "Authorization": `Bearer ${env.TIQETS_API_TOKEN}`,
          "Accept": "application/json",
        },
      },
      TIMEOUT_MS,
    );
    debug.queried = true;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      debug.error = `Tiqets ${res.status}: ${t.slice(0, 200)}`;
      return { results: [], debug };
    }
    data = await res.json();
  } catch (err) {
    debug.error = `fetch failed: ${err?.message || err}`;
    return { results: [], debug };
  }

  // Tiqets responses paginate under either `data` or `products` depending on
  // endpoint version. Accept both.
  const products = Array.isArray(data?.products)
    ? data.products
    : (Array.isArray(data?.data) ? data.data : []);

  const results = products
    .map((p) => normalizeTiqetsProduct(p, env))
    .filter(Boolean)
    // Final relevance pass — Tiqets sometimes returns nearby cities for a
    // small destination. Drop anything that doesn't have a name/city overlap.
    .filter((e) => {
      const target = args.destination || "";
      return fuzzyScore(e.destination || e.name, target) > 0
          || fuzzyScore(e.name, target) > 0;
    });

  debug.count = results.length;
  return { results, debug };
}

function normalizeTiqetsProduct(p, env) {
  if (!p) return null;
  const id = p.id || p.slug || p.uuid;
  if (!id) return null;

  const baseUrl = p.url || (p.slug ? `https://www.tiqets.com/${p.slug}` : null);
  if (!baseUrl) return null;
  const url = withAffiliate("tiqets", baseUrl, env);

  const priceObj = p.price || p.from_price;
  const amount = priceObj?.amount ?? priceObj?.value;
  const currency = priceObj?.currency || "EUR";
  const priceUsd = currency === "USD" ? amount : toUsd(amount, currency);

  const images = []
    .concat(p.image ? [p.image] : [])
    .concat(Array.isArray(p.images) ? p.images : [])
    .map((i) => (typeof i === "string" ? i : i?.url))
    .filter(Boolean);

  return {
    id: `tiqets:${id}`,
    provider: "tiqets",
    name: p.title || p.name || "",
    url,
    destination: p.city?.name || p.location?.city || undefined,
    summary: p.tagline || (p.description ? truncate(p.description, 220) : undefined),
    description: p.description,
    categories: extractTiqetsCategories(p),
    thumbnail: images[0],
    images: images.slice(0, 6),
    rating: p.rating?.average || p.average_rating || undefined,
    reviewCount: p.rating?.count || p.review_count || undefined,
    priceFromUsd: Number.isFinite(priceUsd) ? priceUsd : undefined,
    currency,
    durationMinutes: p.duration?.minutes || undefined,
    tier: priceTier(priceUsd),
    skipTheLine: Boolean(p.attributes?.skip_the_line) || /skip[-\s]the[-\s]line/i.test(p.title || ""),
    bookingMode: "redirect",
    highlights: (p.highlights || p.features || []).slice(0, 5),
  };
}

function extractTiqetsCategories(p) {
  const out = [];
  if (Array.isArray(p.tags)) out.push(...p.tags);
  if (Array.isArray(p.categories)) out.push(...p.categories.map((c) => c?.name || c));
  if (p.category) out.push(p.category);
  return out
    .filter(Boolean)
    .map((c) => String(c).toLowerCase())
    .slice(0, 8);
}

function truncate(s, n) {
  const str = String(s || "");
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + "…";
}
