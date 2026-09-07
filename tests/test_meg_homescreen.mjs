// Tests for src/megHomescreen.js — Meg-only iPhone Home Screen coach.
// Travel must never see it; standalone / dismissed devices skip it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MEG_HOMESCREEN_KEY,
  shouldShowMegHomescreen,
  markMegHomescreenDismissed,
} from "../src/megHomescreen.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

function fakeStorage(initial = {}, { throwMode = null } = {}) {
  const store = { ...initial };
  return {
    getItem(k) {
      if (throwMode === "read") throw new Error("read failed");
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      if (throwMode === "write") throw new Error("quota");
      store[k] = String(v);
    },
    _snapshot() { return { ...store }; },
  };
}

function fakeWindow({
  standalone = false,
  matchesDisplayModeStandalone = false,
  matchMediaThrows = false,
} = {}) {
  return {
    matchMedia: (q) => {
      if (matchMediaThrows) throw new Error("nope");
      return { matches: q === "(display-mode: standalone)" && matchesDisplayModeStandalone };
    },
    navigator: { standalone },
  };
}

const win = fakeWindow();

console.log("=== identity gating ===");
{
  const storage = fakeStorage();
  assert("Travel never sees the coach",
    shouldShowMegHomescreen({ identity: "travel", storage, win }) === false);
  assert("null identity never sees the coach",
    shouldShowMegHomescreen({ identity: null, storage, win }) === false);
  assert("empty identity never sees the coach",
    shouldShowMegHomescreen({ identity: "", storage, win }) === false);
  assert("Meg sees the coach on first unlock",
    shouldShowMegHomescreen({ identity: "meg", storage, win }) === true);
}

console.log("=== dismiss persists for Meg ===");
{
  const storage = fakeStorage();
  assert("first Meg visit shows coach",
    shouldShowMegHomescreen({ identity: "meg", storage, win }) === true);
  const wrote = markMegHomescreenDismissed({ storage });
  assert("Got it writes localStorage", wrote === true);
  assert("key is routesmith-meg-homescreen-v1",
    storage._snapshot()[MEG_HOMESCREEN_KEY] === "1");
  assert("after Got it, Meg does not see it again",
    shouldShowMegHomescreen({ identity: "meg", storage, win }) === false);
  assert("Travel still does not see it after Meg dismissed",
    shouldShowMegHomescreen({ identity: "travel", storage, win }) === false);
}

console.log("=== standalone / already installed ===");
{
  const storage = fakeStorage();
  assert("display-mode: standalone skips coach",
    shouldShowMegHomescreen({
      identity: "meg",
      storage,
      win: fakeWindow({ matchesDisplayModeStandalone: true }),
    }) === false);
  assert("navigator.standalone (iOS) skips coach",
    shouldShowMegHomescreen({
      identity: "meg",
      storage,
      win: fakeWindow({ standalone: true }),
    }) === false);
  assert("matchMedia throw still allows coach (fail open unless standalone flag)",
    shouldShowMegHomescreen({
      identity: "meg",
      storage,
      win: fakeWindow({ matchMediaThrows: true }),
    }) === true);
}

console.log("=== storage failure is non-fatal ===");
{
  const readFail = fakeStorage({}, { throwMode: "read" });
  assert("unreadable localStorage still shows coach (once is better than never)",
    shouldShowMegHomescreen({ identity: "meg", storage: readFail, win }) === true);
  const writeFail = fakeStorage({}, { throwMode: "write" });
  assert("unwritable localStorage: dismiss returns false",
    markMegHomescreenDismissed({ storage: writeFail }) === false);
}

console.log("=== LoginGate wiring (source) ===");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/LoginGate.jsx"), "utf8");
  assert("coach is gated on shouldShowMegHomescreen + identity",
    /shouldShowMegHomescreen\(\{\s*identity:\s*id\s*\}\)/.test(src));
  assert("Got it calls markMegHomescreenDismissed",
    src.includes("markMegHomescreenDismissed()"));
  assert("real iOS labels: Safari", src.includes(">Safari<"));
  assert("real iOS labels: Share", src.includes(">Share<"));
  assert("real iOS labels: Add to Home Screen", src.includes(">Add to Home Screen<"));
  assert("real iOS labels: Add", src.includes(">Add<"));
  assert("dismiss button says Got it", />\s*Got it\s*</.test(src));
  assert("not Chrome is called out", /not Chrome/i.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
