// localProviders.js
// =====================================================================
// Pure, framework-free helper for the "Local providers" feature.
//
// Surfaces real, VETTED local service providers in four categories —
// private drivers / car services, private guides, tours, and wine
// tastings — for the trip's city/legs. ONE source of truth, consumed by
// BOTH the on-screen tab (src/App.jsx) and the PDF section
// (src/pdf/itineraryPdf.js) so the two views can never drift.
//
// HONESTY (see CLAUDE.md "VENUE VERIFICATION — HARD RULE"): this module
// invents NOTHING. It only re-shapes provider records that the network
// layer fetched from the existing real-source + verification pipeline
// (/api/find for tours + tastings, /api/find-providers for drivers +
// guides). Every provider carries the same verify_status / verify_url /
// flags the venue pipeline produces; this module's only judgement is
// mapping that real verification state to an honest UI label
// ("verified" vs "verify-before-booking"). It never upgrades an
// unverified provider to verified.
//
// Pure (no React, no network) so it's unit-tested directly in
// tests/test_local_providers.mjs. The fetching lives in App.jsx.
// =====================================================================

// Ordered category metadata. Order is fixed; views render in this
// sequence and skip any category that isn't relevant to the trip.
//
//   source: "providers"  -> POST /api/find-providers { location, kind }
//           "activities" -> POST /api/find { location, category:"activities", guidelines }
// Drivers + guides use the providers endpoint because /api/find
// explicitly forbids transport/service providers (its no-lodging /
// no-transport guarantee stays intact). Tours + tastings are real
// "places / bookable experiences" that /api/find already returns.
export const PROVIDER_CATEGORIES = [
  {
    id: "drivers",
    label: "Private drivers & car services",
    noun: "private driver or car service",
    source: "providers",
    kind: "drivers",
  },
  {
    id: "guides",
    label: "Private guides",
    noun: "licensed private guide",
    source: "providers",
    kind: "guides",
  },
  {
    id: "tours",
    label: "Tours",
    noun: "tour operator",
    source: "activities",
    guidelines: "guided tours and tour operators — private and small-group day tours, sightseeing tours, food and walking tours",
  },
  {
    id: "tastings",
    label: "Wine tastings",
    noun: "winery / tasting room",
    source: "activities",
    guidelines: "wineries, vineyards, and wine tasting rooms offering tastings to visitors",
  },
];

const CATEGORY_BY_ID = Object.fromEntries(PROVIDER_CATEGORIES.map((c) => [c.id, c]));

export function providerCategoryMeta(id) {
  return CATEGORY_BY_ID[id] || null;
}

// Per-category relevance detectors. A category is relevant when the trip
// plan or the user's inputs reference that kind of service. Mirrors the
// build-prompt detection in src/App.jsx (wantsPrivateDriver /
// wantsPrivateTour) so the providers we surface line up with what the
// itinerary already promised the traveler.
const RELEVANCE_PATTERNS = {
  drivers: /\b(private driver|chauffeur|car service|black car|driver day trip|driver[- ]guide|town car|limo|limousine)\b/i,
  guides: /\b(private guide|licensed guide|local guide|art[- ]historian guide|guided private|private .{0,24}\b(guide|tour)|driver[- ]guide)\b/i,
  tours: /\b(tours?|guided tours?|walking tours?|food tours?|sightseeing|excursion|day trip)\b/i,
  tastings: /\b(wine tasting|wine[- ]tour|winery|wineries|vineyard|tasting room|sommelier|cellar door)\b/i,
};

// Collect every free-text string from the user's inputs + the built plan
// that could signal a provider category. Treated purely as a haystack for
// the relevance regexes — never as instructions, never surfaced as a
// provider name.
export function collectRelevanceHaystack(plan, inputs) {
  const out = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) out.push(v);
    else if (Array.isArray(v)) v.forEach(push);
  };

  if (inputs && typeof inputs === "object") {
    push(inputs?.transport?.type);
    push(inputs?.activities);
    push(inputs?.interests?.text);
    push(inputs?.narrative);
    push(inputs?.guidelines);
    push(inputs?.basics?.style);
  }

  if (plan && typeof plan === "object") {
    push(plan.logistics);
    push(plan.flags);
    if (Array.isArray(plan.days)) {
      for (const day of plan.days) {
        if (!day || !Array.isArray(day.items)) continue;
        for (const item of day.items) {
          if (!item || typeof item !== "object") continue;
          // Only transport + activity item prose can signal a provider;
          // restaurant/flight/hotel items are out of scope.
          if (item.type === "Transport" || item.type === "Activity") {
            push(item.text);
            push(item.why);
          }
        }
      }
    }
  }

  return out;
}

// Which provider categories apply to this trip? Returns category ids in
// PROVIDER_CATEGORIES order. A category is included when ANY collected
// string matches its relevance pattern. Pure — no network, no fabrication.
export function relevantProviderCategories(plan, inputs) {
  const haystack = collectRelevanceHaystack(plan, inputs);
  if (haystack.length === 0) return [];
  const joined = haystack.join("\n");
  return PROVIDER_CATEGORIES.filter((c) => RELEVANCE_PATTERNS[c.id].test(joined)).map((c) => c.id);
}

// verify_status values that mean the place is NOT currently operating.
// Such a provider must never be surfaced (CLAUDE.md hard rule) — drop it.
const CLOSED_STATUSES = new Set(["permanently_closed", "closed_permanently", "not_found"]);

function hasBlockFlag(item) {
  return Array.isArray(item?.flags) && item.flags.some((f) => f && f.severity === "block");
}

// Map a provider's real verification state to an honest UI label. There
// are only two outward labels:
//   "verified"             — Google Places confirmed the business is
//                            operational (server set _verified) and the
//                            model did not flag it for manual checking.
//   "verify_before_booking" — everything else: unverified (no Places key /
//                            lookup failed), or the model wasn't confident.
// We NEVER label an unverified provider "verified". When in doubt the
// honest label is verify-before-booking.
export function providerVerifyLabel(item) {
  if (!item || typeof item !== "object") return "verify_before_booking";
  const verified =
    item._verified === true &&
    item.verify_status !== "verify_before_booking" &&
    !CLOSED_STATUSES.has(String(item.verify_status || "").toLowerCase());
  return verified ? "verified" : "verify_before_booking";
}

// One-line descriptor for a provider card. Built from whatever real
// metadata the pipeline returned — never invented.
function providerDescriptor(item, categoryId) {
  if (categoryId === "tours" || categoryId === "tastings") {
    // /api/find activities: { text:"Name — desc", type, duration, location, why }
    const dash = typeof item.text === "string" ? item.text.indexOf(" — ") : -1;
    const fromText = dash > 0 ? item.text.slice(dash + 3).trim() : "";
    return (
      fromText ||
      item.why ||
      [item.type, item.duration, item.location].filter(Boolean).join(" · ") ||
      ""
    ).trim();
  }
  // /api/find-providers: { name, type, descriptor/why, contact{} }
  return String(item.descriptor || item.why || item.type || "").trim();
}

function providerName(item, categoryId) {
  if (categoryId === "tours" || categoryId === "tastings") {
    const text = typeof item.text === "string" ? item.text : "";
    const dash = text.indexOf(" — ");
    return (dash > 0 ? text.slice(0, dash) : text).trim() || String(item.name || "").trim();
  }
  return String(item.name || "").trim();
}

// Best traveler-facing link for a provider: prefer an official site /
// booking URL, fall back to the verify_url (a search / listing link).
function providerUrl(item) {
  const c = item.contact && typeof item.contact === "object" ? item.contact : {};
  return (
    String(c.website || c.booking_url || item.verify_url || "").trim() || ""
  );
}

// Normalize ONE raw pipeline record (activity or provider) into the flat
// shape both the tab and the PDF render. Returns null for records that
// must not be surfaced (no name, or a block-severity flag).
export function normalizeProvider(raw, categoryId) {
  if (!raw || typeof raw !== "object") return null;
  if (hasBlockFlag(raw)) return null;
  const name = providerName(raw, categoryId);
  if (!name) return null;
  return {
    name,
    descriptor: providerDescriptor(raw, categoryId),
    url: providerUrl(raw),
    verifyLabel: providerVerifyLabel(raw),
    verifyUrl: String(raw.verify_url || "").trim(),
    city: String(raw._city || "").trim(),
    category: categoryId,
  };
}

// Normalize a list of raw records for one category, dropping un-surfaceable
// ones and de-duplicating by name+city (the same operator can come back
// from more than one leg-city query on a multi-city trip).
export function normalizeProviders(rawList, categoryId) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawList) {
    const n = normalizeProvider(raw, categoryId);
    if (!n) continue;
    const key = `${n.name.toLowerCase()}|${n.city.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

// Default per-category cap. The on-screen tab aims for a tight 2-3 each;
// the PDF can afford a few more. Callers pass their own cap.
export const PROVIDER_UI_CAP = 3;
export const PROVIDER_PDF_CAP = 6;

// Build the ordered, capped groups for rendering. `rawByCategory` maps a
// category id to its array of raw pipeline records (network results,
// already tagged with _city by the fetch layer). Only relevant categories
// are returned; each group keeps an (possibly empty) items array so the
// consumer can render an honest empty state.
//
// Returns: [{ id, label, items: NormalizedProvider[], total }]
//   total = de-duped count BEFORE the cap, so the UI/PDF can show
//   "+N more" honestly.
export function bucketProviders(relevantIds, rawByCategory, options = {}) {
  const cap = Number.isFinite(options.cap) ? options.cap : PROVIDER_UI_CAP;
  const ids = Array.isArray(relevantIds) ? relevantIds : [];
  return PROVIDER_CATEGORIES.filter((c) => ids.includes(c.id)).map((c) => {
    const raw = rawByCategory && Array.isArray(rawByCategory[c.id]) ? rawByCategory[c.id] : [];
    const normalized = normalizeProviders(raw, c.id);
    return {
      id: c.id,
      label: c.label,
      noun: c.noun,
      items: cap > 0 ? normalized.slice(0, cap) : normalized,
      total: normalized.length,
    };
  });
}
