// GetYourGuide Partner API adapter.
//
// Docs: https://api.getyourguide.com
// Spec: https://code.getyourguide.com/partner-api-spec/
// Source: https://github.com/getyourguide/partner-api-spec
//
// Partner approval is required to issue an access token. The shape below
// matches the public OpenAPI spec; if your account's contract differs, only
// the auth header and field-mapping in normalizeGygTour() should need edits.
//
// Endpoint: GET /1/tours?q=...&date_from=...&date_to=...&limit=...
// Auth: Basic auth with API_KEY:API_SECRET, or Bearer token depending on the
//       partnership type. We support both.
//
// Env:
//   GYG_API_KEY            Required.
//   GYG_API_SECRET         Optional (Basic auth pair). If absent, GYG_API_KEY
//                          is treated as a Bearer token.
//   GYG_PARTNER_ID         Optional. Appended to deep links.
//   GYG_CMP                Optional campaign tag.

import {
  fetchWithTimeout, priceTier, toUsd, withAffiliate,
} from "./_shared.js";

const GYG_BASE = "https://api.getyourguide.com/1";
const TIMEOUT_MS = 9000;

export async function getYourGuideSearch(args, env) {
  const debug = { provider: "getyourguide", queried: false, count: 0, error: null };

  if (!env.GYG_API_KEY) {
    debug.error = "GYG_API_KEY not set";
    return { results: [], debug };
  }

  const params = new URLSearchParams();
  params.set("q", args.destination || "");
  params.set("limit", String(Math.min(args.limit || 12, 30)));
  params.set("currency", "USD");
  params.set("sort", "popularity");
  if (args.startDate) params.set("date_from", args.startDate);
  if (args.endDate) params.set("date_to", args.endDate);

  const authHeader = env.GYG_API_SECRET
    ? `Basic ${btoa(`${env.GYG_API_KEY}:${env.GYG_API_SECRET}`)}`
    : `Bearer ${env.GYG_API_KEY}`;

  let data;
  try {
    const res = await fetchWithTimeout(
      `${GYG_BASE}/tours?${params.toString()}`,
      {
        headers: {
          "Authorization": authHeader,
          "Accept": "application/json",
          "Accept-Language": "en-US",
        },
      },
      TIMEOUT_MS,
    );
    debug.queried = true;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      debug.error = `GYG ${res.status}: ${t.slice(0, 200)}`;
      return { results: [], debug };
    }
    data = await res.json();
  } catch (err) {
    debug.error = `fetch failed: ${err?.message || err}`;
    return { results: [], debug };
  }

  const tours = []
    .concat(Array.isArray(data?.data?.tours) ? data.data.tours : [])
    .concat(Array.isArray(data?.tours) ? data.tours : []);

  const results = tours
    .map((t) => normalizeGygTour(t, env))
    .filter(Boolean);

  debug.count = results.length;
  return { results, debug };
}

function normalizeGygTour(t, env) {
  if (!t) return null;
  const id = t.tour_id || t.id;
  if (!id) return null;

  const baseUrl = t.url || `https://www.getyourguide.com/-t${id}`;
  const url = withAffiliate("getyourguide", baseUrl, env);

  const price = t.price?.amount ?? t.price_from?.amount;
  const currency = t.price?.currency || t.price_from?.currency || "USD";
  const priceUsd = currency === "USD" ? price : toUsd(price, currency);

  const photoUrls = (t.photos || []).map((p) => p?.url || p).filter(Boolean);

  return {
    id: `gyg:${id}`,
    provider: "getyourguide",
    name: t.title || "",
    url,
    destination: t.location?.name || t.city?.name || undefined,
    summary: t.abstract ? truncate(t.abstract, 220) : undefined,
    description: t.description,
    categories: (t.categories || []).map((c) => String(c?.name || c).toLowerCase()).slice(0, 8),
    thumbnail: photoUrls[0],
    images: photoUrls.slice(0, 6),
    rating: t.review_statistics?.average || t.rating || undefined,
    reviewCount: t.review_statistics?.count || t.review_count || undefined,
    priceFromUsd: Number.isFinite(priceUsd) ? priceUsd : undefined,
    currency,
    durationMinutes: t.duration_minutes || undefined,
    tier: priceTier(priceUsd),
    skipTheLine: /skip[-\s]the[-\s]line/i.test(t.title || ""),
    privateTour: /private/i.test(t.title || "") && Boolean(t.flags?.private),
    bookingMode: "redirect",
    highlights: (t.highlights || []).slice(0, 5),
  };
}

function truncate(s, n) {
  const str = String(s || "");
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trimEnd() + "…";
}
