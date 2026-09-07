// One-time iPhone Home Screen coach for the Meg household identity.
// Chip asked that Meg (iPhone) see Safari “Add to Home Screen” steps the
// first time she unlocks after this ships. Travel never sees it.
//
// Dismiss persists in localStorage so a later Meg unlock on the same
// device does not nag. Already-installed standalone / iOS home-screen
// launches skip the coach entirely.

export const MEG_HOMESCREEN_KEY = "routesmith-meg-homescreen-v1";

function windowOrDefault(win) {
  if (win !== undefined) return win;
  return typeof window !== "undefined" ? window : null;
}

function localStorageOrDefault(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function isStandalone(win) {
  const w = windowOrDefault(win);
  if (!w) return false;
  try {
    if (typeof w.matchMedia === "function" && w.matchMedia("(display-mode: standalone)").matches) {
      return true;
    }
  } catch { /* ignore */ }
  return !!(w.navigator && w.navigator.standalone === true);
}

/**
 * Show the coach only when:
 *   - identity is the Meg household word, AND
 *   - the app is not already running as an installed home-screen app, AND
 *   - this device has not tapped “Got it” yet.
 *
 * @param {{ identity?: string|null, storage?: Storage|null, win?: Window|null }} [opts]
 */
export function shouldShowMegHomescreen({
  identity = null,
  storage,
  win,
} = {}) {
  if (identity !== "meg") return false;
  if (isStandalone(win)) return false;

  const ls = localStorageOrDefault(storage);
  if (!ls) return true;
  try {
    return ls.getItem(MEG_HOMESCREEN_KEY) !== "1";
  } catch {
    return true;
  }
}

export function markMegHomescreenDismissed({ storage } = {}) {
  const ls = localStorageOrDefault(storage);
  if (!ls) return false;
  try {
    ls.setItem(MEG_HOMESCREEN_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
