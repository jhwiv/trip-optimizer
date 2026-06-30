// Tests for src/appIntro.js — the pure helpers behind the first-visit App
// Intro overlay (#9). Guards the dismissal gate, URL/standalone bypasses,
// and the user-agent platform classification.

import {
  WELCOME_STORAGE_KEY,
  shouldShowWelcome,
  markWelcomeDismissed,
  detectPlatform,
} from "../src/appIntro.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Minimal in-memory storage stand-in. Mimics the localStorage API surface we
// actually touch (getItem, setItem) and gives us a third `throwMode` knob to
// simulate Safari private mode quota errors.
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

// Minimal window stand-in. Covers the three things shouldShowWelcome reads:
// location.search (for the ?direct bypass), matchMedia (display-mode), and
// navigator.standalone (iOS Safari install signal).
function fakeWindow({
  search = "",
  standalone = false,
  matchesDisplayModeStandalone = false,
  matchMediaThrows = false,
} = {}) {
  return {
    URLSearchParams,
    location: { search },
    matchMedia: (q) => {
      if (matchMediaThrows) throw new Error("nope");
      return { matches: q === "(display-mode: standalone)" && matchesDisplayModeStandalone };
    },
    navigator: { standalone },
  };
}

console.log("=== shouldShowWelcome — happy path ===");
{
  const win = fakeWindow();
  const storage = fakeStorage();
  assert("first visit (no localStorage flag, no bypass) shows overlay",
    shouldShowWelcome({ win, storage }) === true);

  // After dismissal write, the next call returns false.
  markWelcomeDismissed({ storage });
  assert("after dismissal, subsequent loads do NOT show overlay",
    shouldShowWelcome({ win, storage }) === false);
}

console.log("=== shouldShowWelcome — URL bypass ===");
{
  const storage = fakeStorage();
  assert("?direct=1 bypass — overlay suppressed even on first visit",
    shouldShowWelcome({ win: fakeWindow({ search: "?direct=1" }), storage }) === false);
  assert("?direct (no value) bypass also suppresses",
    shouldShowWelcome({ win: fakeWindow({ search: "?direct" }), storage }) === false);
  assert("?direct=false also suppresses (presence is the trigger, not value)",
    shouldShowWelcome({ win: fakeWindow({ search: "?direct=false" }), storage }) === false);
  assert("?other=1 does NOT bypass",
    shouldShowWelcome({ win: fakeWindow({ search: "?other=1" }), storage }) === true);
}

console.log("=== shouldShowWelcome — standalone-PWA bypass ===");
{
  const storage = fakeStorage();
  assert("iOS Safari running as installed PWA (navigator.standalone) suppresses",
    shouldShowWelcome({ win: fakeWindow({ standalone: true }), storage }) === false);
  assert("Chrome / Edge running as installed PWA (display-mode: standalone) suppresses",
    shouldShowWelcome({ win: fakeWindow({ matchesDisplayModeStandalone: true }), storage }) === false);
  assert("a window where matchMedia throws still falls back to showing the overlay (errs on showing)",
    shouldShowWelcome({ win: fakeWindow({ matchMediaThrows: true }), storage }) === true);
}

console.log("=== shouldShowWelcome — defensive guards ===");
{
  assert("no window (SSR / Node) → never show",
    shouldShowWelcome({ win: null, storage: fakeStorage() }) === false);

  // No storage at all — should still show. The whole point: a first-visit
  // user without writable storage still deserves to see the intro once per
  // load.
  assert("no storage → still show (errs on showing at least once)",
    shouldShowWelcome({ win: fakeWindow(), storage: null }) === true);

  // Storage that throws on read (Safari private mode) — also falls back to
  // showing. The user can dismiss it for this session via component state;
  // it'll re-show next load, which is fine — better than silently swallowing.
  assert("storage that throws on read → still show",
    shouldShowWelcome({ win: fakeWindow(), storage: fakeStorage({}, { throwMode: "read" }) }) === true);

  assert("forceShow=true overrides every bypass except the SSR guard",
    shouldShowWelcome({
      win: fakeWindow({ search: "?direct=1", standalone: true }),
      storage: fakeStorage({ [WELCOME_STORAGE_KEY]: "1" }),
      forceShow: true,
    }) === true);
}

console.log("=== markWelcomeDismissed ===");
{
  const storage = fakeStorage();
  const ok = markWelcomeDismissed({ storage });
  assert("dismissal writes the storage key", ok === true && storage._snapshot()[WELCOME_STORAGE_KEY] === "1");

  // Safari private mode case: setItem throws. The helper must swallow the
  // error and return false (so a future test or caller can choose to react),
  // never throw upward.
  const throwing = fakeStorage({}, { throwMode: "write" });
  const ok2 = markWelcomeDismissed({ storage: throwing });
  assert("dismissal that throws on setItem (Safari private mode) does not throw upward", ok2 === false);

  assert("dismissal with no storage returns false safely",
    markWelcomeDismissed({ storage: null }) === false);
}

console.log("=== detectPlatform ===");
{
  // iOS — every form factor lumped together because the A2HS flow is the
  // same Share-sheet path across iPhone Safari, iPad Safari, and (less
  // commonly) the in-app browsers that piggyback on the system WebKit.
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const ipod = "Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";
  assert("iPhone Safari → ios", detectPlatform(iphone) === "ios");
  assert("iPad Safari → ios", detectPlatform(ipad) === "ios");
  assert("iPod touch → ios", detectPlatform(ipod) === "ios");

  // Android — Chrome, Samsung Internet, and Edge all carry "android".
  const androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  const samsung = "Mozilla/5.0 (Linux; Android 13; SM-G990B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/115.0.0.0 Mobile Safari/537.36";
  const androidEdge = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 EdgA/126.0.0.0";
  assert("Android Chrome → android", detectPlatform(androidChrome) === "android");
  assert("Samsung Internet → android", detectPlatform(samsung) === "android");
  assert("Android Edge → android", detectPlatform(androidEdge) === "android");

  // Desktop — Mac Safari, Windows Chrome, Linux Firefox.
  const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const winChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const linuxFirefox = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
  assert("Mac Safari → desktop", detectPlatform(macSafari) === "desktop");
  assert("Windows Chrome → desktop", detectPlatform(winChrome) === "desktop");
  assert("Linux Firefox → desktop", detectPlatform(linuxFirefox) === "desktop");

  // Guards against bad input. We never throw on a missing or weird UA;
  // we just classify as desktop (the safest default — no pre-expanded
  // mobile-specific panel that might mislead the user).
  assert("undefined UA → desktop (safe default)", detectPlatform(undefined) === "desktop");
  assert("null UA → desktop (safe default)", detectPlatform(null) === "desktop");
  assert("empty string UA → desktop (safe default)", detectPlatform("") === "desktop");
  assert("non-string UA (number) → desktop (safe default)", detectPlatform(123) === "desktop");

  // Ordering: an Android UA must NOT be misread as iOS, even though Chrome's
  // Android UA includes "safari" and "applewebkit" tokens.
  assert("Android UA with 'safari' token is NOT misread as ios",
    detectPlatform(androidChrome) !== "ios");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
