// Pure venue-name comparison helpers. Shared by the Places endpoints
// (functions/api/places-verify.js) and the client-side merge
// (src/placesVerify.js) so the two can never drift to different
// notions of "is this the venue we asked for".
//
// Lives in src/ rather than functions/ because the client bundle must
// be able to import it without pulling in an endpoint's fetch/KV/API-key
// machinery. functions/api/share.js sets the precedent for the reverse
// direction (a Function importing from src/).

// --- Name-similarity guard ----------------------------------------
//
// Google Places (New) Text Search is fuzzy-by-design. When the model
// invents a venue name that doesn't exist, Text Search doesn't return
// zero matches — it picks the best nearby place that loosely resembles
// the query. This is how the Roxanich / Almayer / Lola hallucinations
// shipped: an invented name resolved to a real-but-unrelated venue, and
// our code happily marked it OPERATIONAL.
//
// The guard: after Places resolves a place_id, compute a normalized
// similarity between the QUERY name and the RESOLVED Places name. If
// they're too different, treat as not-found instead of operational.
//
// Similarity metric: Sørensen-Dice on character bigrams. Cheap,
// intuitive (0.0 = no overlap, 1.0 = identical), works well for short
// strings, handles word reorders and substring matches better than
// Levenshtein for venue-name cases.
//
// Normalization (both sides before comparison):
//   1. NFKD + strip diacritics (Café → Cafe)
//   2. Lowercase
//   3. Replace any non-alphanumeric run with single space
//   4. Drop a small stoplist of venue-class words that Places adds and
//      humans omit (or vice-versa): the, restaurant, cafe, hotel,
//      museum, inn, bar, pub, bistro, lounge.
//   5. Collapse whitespace.
//
// Threshold: 0.55. Accepts the legit Places extensions we tested
// against (Loretto Chapel → Loretto Chapel Museum, The Waterhouse →
// Waterhouse Restaurant, Café Sabarsky → Cafe Sabarsky, Aman Venice →
// Aman Venice Hotel) and rejects anything below the bar of a single
// shared meaningful word.
const NAME_STOPLIST = new Set([
  "the", "restaurant", "cafe", "hotel", "museum", "inn", "bar", "pub",
  "bistro", "lounge", "and", "a", "an", "of", "by", "at",
]);
export const SIMILARITY_THRESHOLD = 0.55;

export function normalizeNameForCompare(s) {
  if (typeof s !== "string") return "";
  const stripped = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped.split(" ").filter((t) => t && !NAME_STOPLIST.has(t));
  return tokens.join(" ");
}

export function diceCoefficient(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  if (a.length < 2 || b.length < 2) {
    const setA = new Set(a);
    const setB = new Set(b);
    const inter = [...setA].filter((c) => setB.has(c)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : inter / union;
  }
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersections = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      intersections += 1;
      bigrams.set(bg, count - 1);
    }
  }
  return (2.0 * intersections) / (a.length + b.length - 2);
}

// Returns true when the resolved Places name is similar enough to the
// original query that we trust the match. Pure function.
export function isSimilarEnough(queryName, resolvedName) {
  const a = normalizeNameForCompare(queryName);
  const b = normalizeNameForCompare(resolvedName);
  if (!a || !b) return false;
  if (a === b) return true;
  // Substring escape hatch: if one normalized name fully contains the
  // other and the smaller is at least 3 chars, accept.
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  return diceCoefficient(a, b) >= SIMILARITY_THRESHOLD;
}

// The same comparison as isSimilarEnough, but returning the score rather
// than a verdict, so a caller can apply its own threshold.
//
// Hotels need a stricter bar than the 0.55 the server applies to every
// venue: chain names ("Marriott", "Hilton London") share so much surface
// text that a wrong-property match clears 0.55 comfortably, and a
// traveller sent to the wrong Marriott has no recourse at midnight. The
// substring cases score 1.0 because "London Marriott Hotel Marble Arch"
// containing "Marriott Marble Arch" is Places appending its own venue-class
// words, not a different property.
export function nameMatchScore(queryName, resolvedName) {
  const a = normalizeNameForCompare(queryName);
  const b = normalizeNameForCompare(resolvedName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.includes(a)) return 1;
  if (b.length >= 3 && a.includes(b)) return 1;
  return diceCoefficient(a, b);
}
