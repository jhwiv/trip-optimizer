// Household passphrase gate. Client-side only — a courtesy lock for casual
// visitors, not a security boundary. The accepted words live in this module
// by request (shared household-style unlock). Cloudflare Pages Functions and
// /api/* are NOT covered; anyone who can POST those endpoints still can.
//
// Persistence: sessionStorage. Unlock survives refresh in the same tab and
// is cleared when that tab closes. A new tab must enter a word again.
// The stored value is the matched canonical word ("travel" | "meg") so a
// later personalization pass can tell the two household users apart.

export const GATE_STORAGE_KEY = "routesmith-gate-v1";

// Canonical (lowercased) accepted words. Always compare via
// normalizePassphrase — do not store case variants.
export const GATE_WORDS = Object.freeze(["travel", "meg"]);

export function normalizePassphrase(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

/** @returns {"travel"|"meg"|null} */
export function matchPassphrase(raw) {
  const n = normalizePassphrase(raw);
  if (!n) return null;
  return GATE_WORDS.includes(n) ? n : null;
}

function storageOrDefault(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    // Safari private mode can throw on any sessionStorage access.
    return null;
  }
}

/** @returns {"travel"|"meg"|null} */
export function readGateIdentity({ storage } = {}) {
  const s = storageOrDefault(storage);
  if (!s) return null;
  try {
    const v = s.getItem(GATE_STORAGE_KEY);
    if (typeof v !== "string") return null;
    const n = normalizePassphrase(v);
    return GATE_WORDS.includes(n) ? n : null;
  } catch {
    return null;
  }
}

export function isGateUnlocked(opts) {
  return readGateIdentity(opts) != null;
}

/**
 * Persist an unlock when the word matches. Returns the canonical identity
 * on success, or null when the word is wrong (storage is left untouched).
 * @returns {"travel"|"meg"|null}
 */
export function unlockGate(raw, { storage } = {}) {
  const id = matchPassphrase(raw);
  if (!id) return null;
  const s = storageOrDefault(storage);
  if (s) {
    try { s.setItem(GATE_STORAGE_KEY, id); } catch { /* quota / private mode */ }
  }
  return id;
}
