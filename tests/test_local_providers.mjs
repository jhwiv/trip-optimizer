// Tests for src/localProviders.js — the pure shaping layer behind the
// "Local providers" feature (relevance detection, verify-label mapping,
// normalize/dedupe, and bucketing). Network lives in App.jsx and is NOT
// exercised here. Repo convention: custom assert, prints "N passed, M
// failed", exits non-zero on failure. Auto-discovered by tests/run-all.mjs.

import {
  PROVIDER_CATEGORIES,
  relevantProviderCategories,
  collectRelevanceHaystack,
  providerVerifyLabel,
  normalizeProvider,
  normalizeProviders,
  bucketProviders,
  providerCategoryMeta,
  PROVIDER_UI_CAP,
} from "../src/localProviders.js";
import { activityVerifyName } from "../functions/api/find.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== category metadata ===");
assert("four categories in fixed order", JSON.stringify(PROVIDER_CATEGORIES.map((c) => c.id)) === JSON.stringify(["drivers", "guides", "tours", "tastings"]));
assert("drivers + guides use providers endpoint", providerCategoryMeta("drivers").source === "providers" && providerCategoryMeta("guides").source === "providers");
assert("tours + tastings use activities (find)", providerCategoryMeta("tours").source === "activities" && providerCategoryMeta("tastings").source === "activities");
assert("activities categories carry guidelines", typeof providerCategoryMeta("tours").guidelines === "string" && providerCategoryMeta("tours").guidelines.length > 0);
assert("unknown category id -> null", providerCategoryMeta("nope") === null);

console.log("=== relevance: detect from inputs ===");
assert("private driver in transport -> drivers", relevantProviderCategories(null, { transport: { type: "Private driver for the week" } }).includes("drivers"));
assert("chauffeur -> drivers", relevantProviderCategories(null, { narrative: "we'd like a chauffeur" }).includes("drivers"));
assert("private guide -> guides", relevantProviderCategories(null, { interests: { text: "a licensed private guide for the old town" } }).includes("guides"));
assert("wine tasting -> tastings", relevantProviderCategories(null, { activities: "wine tasting in the valley" }).includes("tastings"));
assert("walking tour -> tours", relevantProviderCategories(null, { guidelines: "a food tour and a walking tour" }).includes("tours"));
// FIX: the singular regex missed the plural "tours" (\btour\b can't match
// inside "tours"). Both forms must match now.
assert("plural 'tours' -> tours", relevantProviderCategories(null, { activities: "book some tours" }).includes("tours"));
assert("singular 'tour' still -> tours", relevantProviderCategories(null, { activities: "a private tour" }).includes("tours"));
assert("'tour'/'tours' regex doesn't over-match 'detour'/'tournament'", relevantProviderCategories(null, { narrative: "a long detour past the tournament" }).length === 0);

console.log("=== relevance: detect from plan items ===");
const plan = {
  days: [
    { items: [
      { type: "Transport", text: "Private driver to the vineyards", why: "" },
      { type: "Activity", text: "Sunset winery tasting", why: "cellar door visit" },
    ] },
    { items: [
      { type: "Dinner", restaurant: { name: "Chauffeur Bistro" } }, // must NOT match (dining item ignored)
    ] },
  ],
};
const fromPlan = relevantProviderCategories(plan, null);
assert("plan transport prose -> drivers", fromPlan.includes("drivers"));
assert("plan activity prose -> tastings", fromPlan.includes("tastings"));
assert("dining item prose is ignored (no false guides/drivers from 'Chauffeur Bistro')", !relevantProviderCategories({ days: [{ items: [{ type: "Dinner", restaurant: { name: "Chauffeur Bistro" } }] }] }, null).length);

console.log("=== relevance: ordering + empty ===");
const all = relevantProviderCategories(null, { transport: { type: "private driver" }, activities: "wine tasting", guidelines: "walking tour", interests: { text: "private guide" } });
assert("returns ids in PROVIDER_CATEGORIES order", JSON.stringify(all) === JSON.stringify(["drivers", "guides", "tours", "tastings"]));
assert("no signal -> []", relevantProviderCategories({ days: [] }, { narrative: "a quiet beach week" }).length === 0);
assert("null/empty inputs -> []", relevantProviderCategories(null, null).length === 0);

console.log("=== haystack: scope ===");
const hay = collectRelevanceHaystack(plan, { transport: { type: "town car" } });
assert("includes input transport", hay.some((s) => /town car/.test(s)));
assert("includes plan transport text", hay.some((s) => /Private driver to the vineyards/.test(s)));
assert("excludes dining restaurant names", !hay.some((s) => /Chauffeur Bistro/.test(s)));

console.log("=== verify label: honest mapping ===");
assert("verified only when _verified + not flagged", providerVerifyLabel({ _verified: true }) === "verified");
assert("not verified when _verified missing", providerVerifyLabel({ verify_status: "" }) === "verify_before_booking");
assert("verify_before_booking status wins over _verified", providerVerifyLabel({ _verified: true, verify_status: "verify_before_booking" }) === "verify_before_booking");
assert("permanently_closed never verified", providerVerifyLabel({ _verified: true, verify_status: "permanently_closed" }) === "verify_before_booking");
assert("null -> verify_before_booking", providerVerifyLabel(null) === "verify_before_booking");

console.log("=== activity text->name verification (tours/tastings honesty) ===");
// Activities (tours/tastings) carry their name in `text`, not `name`. The
// server derives a verify name from `text` so they get a REAL Places check
// (same fn the find.js verification pass calls). Proven here: derivation works
// for the activity shape, and when it FAILS the item can never be labeled
// "verified" — it falls back to verify_before_booking, never a false claim.
assert("activity-shaped (text only) yields a derived name", activityVerifyName({ text: "Tuscan Cellar Tastings — vineyard visits" }) === "Tuscan Cellar Tastings");
assert("activity with no derivable name -> '' (will be UNVERIFIED, not verified)", activityVerifyName({ why: "no name" }) === "");
// An activity whose name couldn't be derived is never verified server-side
// (_verified stays falsy) → the UI label must be verify_before_booking.
assert("derivation-failed activity -> verify_before_booking (never 'verified')", providerVerifyLabel({ text: "", why: "x" }) === "verify_before_booking");
// A genuinely Places-verified activity (server set _verified) -> "verified".
assert("server-verified activity -> verified", providerVerifyLabel({ _verified: true, text: "Real Winery — tastings" }) === "verified");

console.log("=== normalize: providers shape (drivers/guides) ===");
const driver = normalizeProvider({ name: "High Mountain Limo", type: "Limo service", descriptor: "Black-car airport runs.", contact: { website: "https://hml.example" }, _verified: true, _city: "Sedona" }, "drivers");
assert("driver name carried", driver.name === "High Mountain Limo");
assert("driver descriptor carried", driver.descriptor === "Black-car airport runs.");
assert("driver url prefers website", driver.url === "https://hml.example");
assert("driver verified label", driver.verifyLabel === "verified");
assert("driver city carried from _city", driver.city === "Sedona");

console.log("=== normalize: activities shape (tours/tastings) ===");
const tour = normalizeProvider({ text: "Context Travel — art-historian led private tours", why: "deep-dive guides", verify_url: "https://g.example/ctx", _city: "Florence" }, "tours");
assert("tour name = part before em-dash", tour.name === "Context Travel");
assert("tour descriptor = part after em-dash", tour.descriptor === "art-historian led private tours");
assert("tour falls back to verify_url for link", tour.url === "https://g.example/ctx");
assert("tour without _verified -> verify_before_booking", tour.verifyLabel === "verify_before_booking");

console.log("=== normalize: drop rules ===");
assert("no name -> null", normalizeProvider({ descriptor: "x" }, "drivers") === null);
assert("block flag -> null", normalizeProvider({ name: "Closed Co", flags: [{ severity: "block", code: "NOT_FOUND" }] }, "drivers") === null);
assert("non-object -> null", normalizeProvider(null, "drivers") === null);

console.log("=== normalize list: dedupe by name+city ===");
const list = normalizeProviders([
  { name: "ToursByLocals", _city: "Rome" },
  { name: "toursbylocals", _city: "Rome" }, // dup (case-insensitive)
  { name: "ToursByLocals", _city: "Florence" }, // distinct city -> kept
  { name: "", _city: "Rome" }, // dropped (no name)
], "guides");
assert("dedupes case-insensitively within a city", list.length === 2, JSON.stringify(list.map((p) => `${p.name}|${p.city}`)));

console.log("=== bucketProviders: order, cap, total, empty state ===");
const raw = {
  drivers: [
    { name: "D1", _verified: true }, { name: "D2" }, { name: "D3" }, { name: "D4" },
  ],
  tastings: [], // relevant but nothing verifiable -> empty items, total 0
};
const groups = bucketProviders(["drivers", "tastings"], raw, { cap: 2 });
assert("only requested categories, in order", JSON.stringify(groups.map((g) => g.id)) === JSON.stringify(["drivers", "tastings"]));
assert("drivers capped to 2 items", groups[0].items.length === 2);
assert("drivers total reflects pre-cap count", groups[0].total === 4);
assert("empty category keeps an empty items array + total 0", groups[1].items.length === 0 && groups[1].total === 0);
assert("group carries label + noun for UI", typeof groups[0].label === "string" && typeof groups[0].noun === "string");

const defaultCap = bucketProviders(["drivers"], raw);
assert("default cap = PROVIDER_UI_CAP", defaultCap[0].items.length === Math.min(PROVIDER_UI_CAP, 4));
assert("irrelevant ids excluded", bucketProviders([], raw).length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
