// Gating for /find's local-expert pass (the Sonar-grounded "Locally sourced"
// section that fans out to regional press, local forums, and area guides).
//
// This decision used to be inline in FindView and keyed off the standard pass
// having produced results. That got it backwards: a query returning nothing —
// or 422ing outright — received no hyperlocal grounding at all, when a small
// town that national travel press barely covers is precisely the query where
// regional press and forums beat the model's own recall. The pass now keys off
// the submitted query instead, so it runs whether the standard pass succeeded,
// came back empty, or failed.
//
// Lives in its own module because src/App.jsx cannot be imported from the
// plain-node test harness (same rationale as src/swapAlternatives.js).

// NUL is used as the field separator so a guidelines paragraph containing
// pipes or commas can't collide with a different query's signature.
export const FIND_SIG_SEP = "\u0000";

// Identity of a submitted /find query. Two submissions with the same location,
// category, and guidelines share a signature and must not each trigger their
// own local-expert pass.
export function findQuerySignature(query) {
  if (!query || typeof query !== "object") return "";
  const location = String(query.location || "").trim();
  if (!location) return "";
  return [location, String(query.category || ""), String(query.guidelines || "")].join(FIND_SIG_SEP);
}

// Returns null when the local-expert pass should not fire, or
// { sig, standalone } when it should. `standalone` means the standard pass
// produced nothing, so these results will be the only ones on the page —
// the caller uses it to pick honest copy instead of "your original list
// above is unchanged".
export function shouldAutoFireLocalPass({
  submittedQuery,
  results,
  localExpertResults,
  loading,
  askingLocals,
  lastFiredKey,
} = {}) {
  const sig = findQuerySignature(submittedQuery);
  if (!sig) return null;
  // Never open a second request while one is already in flight.
  if (loading || askingLocals) return null;
  // Locals' picks are already on the page for this submission.
  if (localExpertResults) return null;
  if (lastFiredKey === sig) return null;
  return { sig, standalone: !results };
}
