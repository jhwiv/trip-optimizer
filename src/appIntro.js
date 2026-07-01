// Pure helpers for the first-visit App Intro overlay (#9). Kept out of App.jsx
// so the localStorage gate, URL bypass, and platform detection are unit-
// testable without a DOM. The actual overlay component lives in App.jsx and
// composes these helpers.

// localStorage key. Versioned so a future major change to the intro copy can
// trigger a re-show without colliding with the prior generation.
export const WELCOME_STORAGE_KEY = "routesmith-welcomed-v2";

// Decide whether to show the welcome overlay on this load. Returns true when:
//   - localStorage doesn't carry a prior dismissal for this key, AND
//   - the URL doesn't carry ?direct=1 (used for embeds, shared previews,
//     and QA flows that need to land on the wizard immediately), AND
//   - the app isn't already running as a standalone PWA (no point pitching
//     A2HS to a user who already installed it), AND
//   - we have a window object to begin with (SSR / Node test guards).
//
// Storage is wrapped in try/catch because Safari private mode can throw on
// any access. A failure to read the gate falls open — we still show the
// overlay; worst case the user dismisses it twice.
export function shouldShowWelcome({
  win,
  storage,
  forceShow = false,
} = {}) {
  // Node / test guard. Defaults to the browser globals when present.
  const w = win === undefined ? (typeof window !== "undefined" ? window : null) : win;
  const ls = storage === undefined ? (typeof localStorage !== "undefined" ? localStorage : null) : storage;
  if (!w) return false;

  if (forceShow) return true;

  // ?direct=1 bypass — used for shared previews, embeds, and any QA flow
  // that needs to land on the wizard immediately. Also accepts ?direct
  // (no value) for convenience.
  try {
    const params = new w.URLSearchParams(w.location && w.location.search ? w.location.search : "");
    if (params.has("direct")) return false;
  } catch {
    // Malformed URL or no URLSearchParams — fall through; the dismissal
    // check below is still meaningful.
  }

  // Already-installed standalone bypass. `display-mode: standalone` is the
  // PWA install signal on Chrome / Edge / Android; `navigator.standalone`
  // is the equivalent on iOS Safari. If either is true, the user already
  // installed the app and pitching A2HS again would be annoying.
  try {
    if (typeof w.matchMedia === "function" && w.matchMedia("(display-mode: standalone)").matches) return false;
  } catch {}
  if (w.navigator && w.navigator.standalone === true) return false;

  // localStorage gate. Treat any throw or unexpected shape as "not yet
  // dismissed" so we err on the side of showing the intro at least once.
  if (!ls) return true;
  try {
    return ls.getItem(WELCOME_STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

// Persist the dismissal. Wrapped because Safari private mode throws on
// localStorage.setItem with QuotaExceededError. Failure is non-fatal — the
// user dismissed it for THIS session via state; they'll see it again next
// load if storage truly isn't writable, which is acceptable.
export function markWelcomeDismissed({ storage } = {}) {
  const ls = storage === undefined ? (typeof localStorage !== "undefined" ? localStorage : null) : storage;
  if (!ls) return false;
  try {
    ls.setItem(WELCOME_STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// Best-effort platform detection from a user-agent string. Used to pre-expand
// the "Add to Home Screen" instructions panel that matches the user's device,
// so they're not staring at the wrong steps. Returns one of:
//   "ios"     — iPhone / iPad / iPod Safari (the only browser that can install
//               on iOS; Chrome on iOS is just a Safari skin and the A2HS
//               affordance is the same Share -> Add to Home Screen flow)
//   "android" — Android Chrome / Edge / Samsung Internet
//   "desktop" — everything else (Mac / Windows / Linux Chrome, Edge, Firefox,
//               Safari desktop). Desktop browsers do install PWAs (Chrome's
//               install icon in the URL bar, Edge's Apps menu) but the flow
//               is different enough that we don't pre-expand a panel.
//
// The classification is intentionally simple. We don't try to detect specific
// browser versions or capabilities; this is a UX hint, not gating logic.
export function detectPlatform(userAgent) {
  if (typeof userAgent !== "string" || userAgent.length === 0) return "desktop";
  const ua = userAgent.toLowerCase();
  // iPadOS 13+ identifies as "Macintosh" with touch support, but for the
  // A2HS panel the instructions are still the iOS Safari Share-sheet flow,
  // so we lump iPad in with iOS. Detect via the iPad-specific keywords
  // OR by the "Mac" + touch combo on a mobile-ish UA.
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  // Android Chrome / Edge / Samsung Internet all carry "android" in the UA.
  // Chrome on Android also includes "mobile safari" tokens we don't want
  // to misread as iOS, so the android check must come AFTER the explicit
  // ios check above (which it does).
  if (/android/.test(ua)) return "android";
  return "desktop";
}
