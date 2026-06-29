// Tests for src/outputsState.js — the pure restore guard for the build
// "output sections" selection. Repo convention: custom assert, prints
// "N passed, M failed", exits non-zero on failure. Auto-discovered by
// tests/run-all.mjs.
//
// What this guards: the output-section toggles are the only user-input bucket
// that used to live purely in memory, so a remount mid-build silently reset
// them to defaults — dropping every add-on section and leaving only the
// flight + hotel logistics (which render from input data, not toggles).
// resolveOutputs proves a persisted selection is restored verbatim (never
// reset to defaults) once the user has chosen sections.

import { DEFAULT_OUTPUTS, defaultOutputs, resolveOutputs } from "../src/outputsState.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

const ALL_KEYS = [
  "itinerary", "weather", "navigation", "logistics", "tonight", "menus",
  "flags", "planb", "snobs", "practical", "badges", "pronunciation",
];

console.log("\n[1] DEFAULT_OUTPUTS shape");
{
  assert("has exactly the 12 known keys", ALL_KEYS.every(k => k in DEFAULT_OUTPUTS) && Object.keys(DEFAULT_OUTPUTS).length === 12, JSON.stringify(Object.keys(DEFAULT_OUTPUTS)));
  assert("itinerary defaults on", DEFAULT_OUTPUTS.itinerary === true);
  // New spec (#4): preselect all sections except the last two in display order.
  const OFF_BY_DEFAULT = ["badges", "pronunciation"];
  assert("only badges & pronunciation default off", ALL_KEYS.every(k => OFF_BY_DEFAULT.includes(k) ? DEFAULT_OUTPUTS[k] === false : DEFAULT_OUTPUTS[k] === true));
  assert("exactly 10 sections default on", ALL_KEYS.filter(k => DEFAULT_OUTPUTS[k] === true).length === 10);
  assert("defaultOutputs() returns a fresh copy", defaultOutputs() !== DEFAULT_OUTPUTS && JSON.stringify(defaultOutputs()) === JSON.stringify(DEFAULT_OUTPUTS));
  // The frozen canonical must not be mutated through the fresh copy.
  const copy = defaultOutputs();
  copy.badges = true;
  assert("mutating the copy never touches the canonical", DEFAULT_OUTPUTS.badges === false && copy.badges === true);
}

console.log("\n[2] resolveOutputs falls back to defaults when nothing valid is persisted");
{
  assert("null -> defaults", JSON.stringify(resolveOutputs(null)) === JSON.stringify(DEFAULT_OUTPUTS));
  assert("undefined -> defaults", JSON.stringify(resolveOutputs(undefined)) === JSON.stringify(DEFAULT_OUTPUTS));
  assert("array -> defaults", JSON.stringify(resolveOutputs([1, 2])) === JSON.stringify(DEFAULT_OUTPUTS));
  assert("string -> defaults", JSON.stringify(resolveOutputs("nope")) === JSON.stringify(DEFAULT_OUTPUTS));
  assert("result is a fresh object, not the frozen canonical", resolveOutputs(null) !== DEFAULT_OUTPUTS);
}

console.log("\n[3] resolveOutputs PRESERVES a persisted user selection (the core guard)");
{
  // The reported failure mode: user turned several add-ons ON, then a remount
  // reset them. With a persisted snapshot, resolveOutputs must restore the
  // user's exact picks rather than collapsing back to defaults.
  const userPicked = {
    itinerary: true, weather: true, navigation: false, logistics: true,
    tonight: true, menus: false, flags: true, planb: true, snobs: true,
    practical: false, badges: false, pronunciation: false,
  };
  const restored = resolveOutputs(userPicked);
  assert("weather preserved on", restored.weather === true);
  assert("logistics preserved on", restored.logistics === true);
  assert("snobs preserved on", restored.snobs === true);
  assert("planb preserved on", restored.planb === true);
  assert("menus preserved off", restored.menus === false);
  assert("full selection round-trips byte-for-byte", JSON.stringify(restored) === JSON.stringify(userPicked));
  // A selection with several add-ons on must NOT equal the defaults — proves
  // we are not silently resetting to flight+hotel-only defaults.
  assert("restored selection differs from defaults", JSON.stringify(restored) !== JSON.stringify(DEFAULT_OUTPUTS));
}

console.log("\n[4] resolveOutputs invariants: itinerary forced on, missing keys backfilled");
{
  // Even if a corrupt/old snapshot had itinerary off, it renders locked-on, so
  // restore must force it true to keep the build from producing an empty plan.
  const r1 = resolveOutputs({ itinerary: false, weather: true });
  assert("itinerary forced on even when stored false", r1.itinerary === true);
  assert("stored weather still honored", r1.weather === true);
  // A partial map (e.g. an older snapshot before a new section existed) is
  // backfilled from defaults so the key set always matches outputDefs.
  const r2 = resolveOutputs({ weather: true });
  // Missing keys are backfilled from DEFAULT_OUTPUTS (not hardcoded values).
  // navigation/snobs default ON under the #4 spec; badges/pronunciation OFF.
  assert("missing on-by-default keys backfilled true", r2.navigation === true && r2.snobs === true);
  assert("missing off-by-default keys backfilled false", r2.badges === false && r2.pronunciation === false);
  assert("backfilled keys match DEFAULT_OUTPUTS", ALL_KEYS.filter(k => k !== "weather" && k !== "itinerary").every(k => r2[k] === DEFAULT_OUTPUTS[k]));
  assert("backfilled map has all 12 keys", ALL_KEYS.every(k => k in r2));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
