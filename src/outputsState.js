// outputsState.js
// =====================================================================
// Pure, framework-free helpers for the build "output sections" selection.
//
// The output-section toggles (itinerary + add-ons like weather, dining,
// snobs, plan B, …) are the ONLY user-input bucket that used to live purely
// in memory: unlike basics/flights/hotel/etc. they were never written to the
// session snapshot and never restored on mount. Any remount mid-flow (PWA
// update, mobile tab discard/restore, self-heal reload) therefore silently
// reset the user's chosen sections back to defaults. Because the build prompt
// requests sections straight from this map ("Include sections: …") and the
// flight/hotel cards render from input data regardless of the toggles, a
// defaults-reset produced exactly the reported symptom: every add-on section
// cleared, leaving only the flight + hotel logistics.
//
// Centralizing the default map + the restore logic here gives one source of
// truth (App.jsx previously inlined the same object literal in two places)
// and a pure unit boundary for tests/test_outputs_state.mjs.
// =====================================================================

// The canonical default selection. Day-by-day itinerary is always on (a plan
// with no days is meaningless, so its toggle is rendered locked-on).
// Default selection: every section ON except the last two in DISPLAY order
// (outputDefs in App.jsx): "badges" and "pronunciation" default OFF. The user
// asked to "preselect all but the last 2". Anchored to display order, NOT
// object-key order, to avoid the documented defaults-reset regression above.
export const DEFAULT_OUTPUTS = Object.freeze({
  itinerary: true,
  weather: true,
  cost: true,
  navigation: true,
  logistics: true,
  tonight: true,
  menus: true,
  flags: true,
  planb: true,
  snobs: true,
  practical: true,
  badges: false,
  pronunciation: false,
});

// A fresh, mutable copy of the defaults so React state can't accidentally
// share/mutate the frozen canonical object.
export function defaultOutputs() {
  return { ...DEFAULT_OUTPUTS };
}

// Resolve the outputs map to restore on mount / saved-trip open / build
// resume. When a persisted selection exists (session snapshot or saved trip)
// it is kept verbatim so a remount mid-build never silently drops the user's
// chosen sections — the core guard against the reported "sections cleared to
// flight + hotel only" bug. Falls back to defaults when nothing valid was
// persisted. Unknown-but-missing keys are backfilled from defaults (forward
// compatible if a new section is added later) and itinerary is always forced
// on regardless of what was stored.
//
// @param {object|null|undefined} saved  previously-persisted outputs map
// @returns {object} a fresh outputs map safe to hand to setState
export function resolveOutputs(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    return defaultOutputs();
  }
  return { ...DEFAULT_OUTPUTS, ...saved, itinerary: true };
}
