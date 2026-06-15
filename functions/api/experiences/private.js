// Private operator "adapter" — reads from the curated directory and returns
// matching operators as normalized Experiences. No external API, so this
// works offline and is the most reliable provider in the stack.
//
// The directory lives in _private-directory.js so editorial updates don't
// require touching matching logic.

import { PRIVATE_OPERATORS } from "./_private-directory.js";
import { fuzzyScore, shortHash } from "./_shared.js";

/**
 * @param {Object} args
 * @param {string} args.destination
 * @param {string[]} [args.interests]
 * @param {number} [args.limit]
 */
export async function privateSearch(args, _env) {
  const debug = { provider: "private", queried: true, count: 0, error: null };
  const destQuery = String(args.destination || "").trim();
  if (!destQuery) {
    debug.error = "no destination";
    return { results: [], debug };
  }

  // Score each operator by destination overlap. Anything > 0 is a candidate.
  // We then layer interest matches as a tiebreaker.
  const scored = [];
  for (const op of PRIVATE_OPERATORS) {
    let best = 0;
    for (const d of op.destinations || []) {
      const match = typeof d === "string" ? d : d.match;
      const score = Math.max(
        fuzzyScore(match, destQuery),
        fuzzyScore(destQuery, match),
      );
      if (score > best) best = score;
    }
    if (best === 0) continue;

    let interestBoost = 0;
    if (Array.isArray(args.interests) && args.interests.length) {
      const cats = (op.categories || []).join(" ");
      for (const i of args.interests) {
        if (fuzzyScore(cats, i) > 0) interestBoost += 0.1;
      }
    }

    scored.push({ op, score: best + interestBoost });
  }

  scored.sort((a, b) => b.score - a.score);
  const limit = Math.min(args.limit || 12, 30);

  const results = scored.slice(0, limit).map(({ op }) => normalizePrivate(op));
  debug.count = results.length;
  return { results, debug };
}

function normalizePrivate(op) {
  return {
    id: `private:${op.id || shortHash(`${op.operator}:${op.url || ""}`)}`,
    provider: "private",
    name: `${op.operator} — ${firstDestination(op)}`,
    url: op.url,
    destination: firstDestination(op),
    summary: op.summary,
    description: op.description,
    categories: op.categories || [],
    thumbnail: op.thumbnail,
    images: op.thumbnail ? [op.thumbnail] : [],
    rating: undefined,
    reviewCount: undefined,
    priceFromUsd: op.priceFromUsd,
    currency: "USD",
    durationMinutes: undefined,
    tier: op.tier,
    privateTour: true,
    operator: op.operator,
    bookingMode: op.bookingMode || "redirect",
    contactEmail: op.contactEmail,
    contactPhone: op.contactPhone,
    highlights: op.highlights || [],
  };
}

function firstDestination(op) {
  const d = (op.destinations || [])[0];
  return typeof d === "string" ? d : (d?.label || d?.match || "");
}
