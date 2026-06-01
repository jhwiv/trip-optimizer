// Shared types, helpers, and the normalized Experience shape used across
// every experiences provider (Viator, Tiqets, GetYourGuide, Private).
//
// Why a normalized shape:
//   The build prompt in src/App.jsx already understands an Activity item with
//   { name, contact, booking_url, why, ... }. Each provider returns wildly
//   different JSON. We normalize at the edge so the AI ranker, the day-planner
//   prompt, and the UI all consume a single, stable shape regardless of source.
//
// One Experience per row returned to the client. Optional fields stay optional;
// renderers should treat anything but `id`, `provider`, `name`, and `url` as
// best-effort.

/**
 * @typedef {Object} Experience
 * @property {string} id                  Provider-prefixed stable id, e.g. "viator:5678-VIATORTOUR"
 * @property {"viator"|"tiqets"|"getyourguide"|"private"} provider
 * @property {string} name                Display title
 * @property {string} url                 Affiliate/deep-link booking URL (will be URL-verified)
 * @property {string} [destination]       Free-text destination match, e.g. "Lisbon, Portugal"
 * @property {string} [summary]           One-line teaser
 * @property {string} [description]       Longer paragraph (HTML allowed; we sanitize on render)
 * @property {string[]} [categories]      Provider tags / categories (normalized lowercase)
 * @property {string} [thumbnail]         Hero image URL
 * @property {string[]} [images]          Additional images
 * @property {number} [rating]            0–5
 * @property {number} [reviewCount]       Total reviews
 * @property {number} [priceFromUsd]      Lowest adult price, USD (best-effort conversion)
 * @property {string} [currency]          Original currency code if not USD
 * @property {number} [durationMinutes]   Typical duration in minutes
 * @property {"low"|"mid"|"high"|"ultra"} [tier]   Editorial price tier (post-normalize)
 * @property {boolean} [skipTheLine]      Tiqets-style attribute
 * @property {boolean} [privateTour]      One party only
 * @property {string} [operator]          For private layer: "Context Travel", "ToursByLocals", etc.
 * @property {string[]} [highlights]      Bullet list
 * @property {string} [bookingMode]       "instant" | "inquiry" | "redirect"
 * @property {string} [contactEmail]      For inquiry-mode private operators
 * @property {string} [contactPhone]
 * @property {Object} [raw]               Provider-native payload, for debugging only
 */

/**
 * Map a USD numeric price to an editorial tier. Tiers are deliberately coarse
 * — the ranker uses them as a soft signal, not a hard filter.
 */
export function priceTier(usd) {
  if (!Number.isFinite(usd)) return undefined;
  if (usd < 50) return "low";
  if (usd < 150) return "mid";
  if (usd < 500) return "high";
  return "ultra";
}

/**
 * Best-effort currency → USD conversion. We don't ship live FX rates in the
 * Worker; downstream callers can override by passing usdRate. Most providers
 * already return USD when we send a USD locale header, so this is a fallback.
 */
const FX_FALLBACK = {
  USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.13, JPY: 0.0064,
  AUD: 0.66, CAD: 0.73, SEK: 0.094, NOK: 0.092, DKK: 0.145,
};
export function toUsd(amount, currency) {
  if (!Number.isFinite(amount)) return undefined;
  const code = String(currency || "USD").toUpperCase();
  const rate = FX_FALLBACK[code] ?? 1;
  return Math.round(amount * rate * 100) / 100;
}

/**
 * JSON response with permissive CORS, matching the rest of /functions/api/*.
 */
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function corsOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

/**
 * Run a fetch with a hard timeout. Cloudflare's `fetch` doesn't respect
 * AbortController on the platform level the same way Node does, but the
 * runtime honors `signal` for the request lifecycle, which is what we need.
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Append affiliate tracking params to a booking URL. Each provider has its own
 * convention; we keep them isolated here so the adapter code stays readable.
 */
export function withAffiliate(provider, baseUrl, env) {
  try {
    const u = new URL(baseUrl);
    if (provider === "viator" && env.VIATOR_PARTNER_ID) {
      // Viator Affiliate links use `pid` to attribute the click. The exact
      // parameter name comes from the partner dashboard; `pid` is the documented
      // default for Basic Access. If your account uses a different one, update
      // here.
      u.searchParams.set("pid", env.VIATOR_PARTNER_ID);
      if (env.VIATOR_SUB_ID) u.searchParams.set("mcid", env.VIATOR_SUB_ID);
    } else if (provider === "getyourguide" && env.GYG_PARTNER_ID) {
      u.searchParams.set("partner_id", env.GYG_PARTNER_ID);
      if (env.GYG_CMP) u.searchParams.set("cmp", env.GYG_CMP);
    } else if (provider === "tiqets" && env.TIQETS_PARTNER_ID) {
      u.searchParams.set("partner", env.TIQETS_PARTNER_ID);
    }
    return u.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * Lightweight word-overlap scoring used by the aggregator when we don't have
 * vector embeddings yet. Returns 0..1.
 */
export function fuzzyScore(haystack, needle) {
  if (!haystack || !needle) return 0;
  const h = String(haystack).toLowerCase();
  const n = String(needle).toLowerCase();
  if (h.includes(n)) return 1;
  // Tokenize on whitespace AND punctuation so "Lisbon, Portugal" → ["lisbon",
  // "portugal"] and matches "Lisbon". Drop very short tokens (1–2 chars) to
  // avoid noisy hits on common prefixes.
  const words = n.split(/[\s,;/\\\-–—.()[\]]+/).filter((w) => w && w.length > 2);
  if (!words.length) return 0;
  let hit = 0;
  for (const w of words) if (h.includes(w)) hit++;
  return hit / words.length;
}

/**
 * Stable string hash → short id (used when a provider doesn't give us a stable
 * id for a private operator, etc.). Not cryptographic.
 */
export function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
