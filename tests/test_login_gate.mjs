// Tests for src/loginGate.js — household dual-passphrase unlock.
// Guards case-insensitivity, trim, reject-wrong, and sessionStorage persist.

import {
  GATE_STORAGE_KEY,
  GATE_WORDS,
  normalizePassphrase,
  matchPassphrase,
  isGateUnlocked,
  unlockGate,
  readGateIdentity,
} from "../src/loginGate.js";

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

console.log("=== normalize / match — Travel ===");
{
  assert("Travel matches", matchPassphrase("Travel") === "travel");
  assert("travel matches", matchPassphrase("travel") === "travel");
  assert("TRAVEL matches", matchPassphrase("TRAVEL") === "travel");
  assert("  Travel  (trimmed) matches", matchPassphrase("  Travel  ") === "travel");
  assert("tRaVeL mixed case matches", matchPassphrase("tRaVeL") === "travel");
}

console.log("=== normalize / match — Meg ===");
{
  assert("Meg matches", matchPassphrase("Meg") === "meg");
  assert("meg matches", matchPassphrase("meg") === "meg");
  assert("MEG matches", matchPassphrase("MEG") === "meg");
  assert("  meg  (trimmed) matches", matchPassphrase("  meg  ") === "meg");
}

console.log("=== reject wrong / empty / near-miss ===");
{
  assert("empty string is rejected", matchPassphrase("") === null);
  assert("whitespace-only is rejected", matchPassphrase("   ") === null);
  assert("null is rejected", matchPassphrase(null) === null);
  assert("undefined is rejected", matchPassphrase(undefined) === null);
  assert("number is rejected", matchPassphrase(123) === null);
  assert("'Traveler' is rejected", matchPassphrase("Traveler") === null);
  assert("'mega' is rejected", matchPassphrase("mega") === null);
  assert("'password' is rejected", matchPassphrase("password") === null);
  assert("'Travel!' is rejected", matchPassphrase("Travel!") === null);
}

console.log("=== unlock + session persist ===");
{
  const storage = fakeStorage();
  assert("starts locked", isGateUnlocked({ storage }) === false);
  assert("wrong word does not unlock", unlockGate("nope", { storage }) === null);
  assert("still locked after wrong word", isGateUnlocked({ storage }) === false);
  assert("storage untouched after reject", storage._snapshot()[GATE_STORAGE_KEY] === undefined);

  const id = unlockGate(" Travel ", { storage });
  assert("Travel unlocks as 'travel'", id === "travel");
  assert("isGateUnlocked after Travel", isGateUnlocked({ storage }) === true);
  assert("identity stored as canonical travel", readGateIdentity({ storage }) === "travel");
  assert("refresh-equivalent read still unlocked", isGateUnlocked({ storage }) === true);
}

console.log("=== Meg identity stored separately ===");
{
  const storage = fakeStorage();
  assert("Meg unlocks as 'meg'", unlockGate("MEG", { storage }) === "meg");
  assert("identity stored as canonical meg", readGateIdentity({ storage }) === "meg");
}

console.log("=== storage failure is non-fatal ===");
{
  const writeFail = fakeStorage({}, { throwMode: "write" });
  // Match still succeeds even if persist throws — in-memory unlock can proceed.
  assert("unlockGate returns identity when setItem throws",
    unlockGate("travel", { storage: writeFail }) === "travel");

  const readFail = fakeStorage({ [GATE_STORAGE_KEY]: "travel" }, { throwMode: "read" });
  assert("isGateUnlocked falls closed when getItem throws",
    isGateUnlocked({ storage: readFail }) === false);
}

console.log("=== canonical word list is lowercase only ===");
{
  assert("GATE_WORDS is travel + meg",
    GATE_WORDS.length === 2 && GATE_WORDS.includes("travel") && GATE_WORDS.includes("meg"));
  assert("no uppercase variants stored",
    GATE_WORDS.every((w) => w === w.toLowerCase()));
}

console.log("=== normalizePassphrase ===");
{
  assert("trim + lower", normalizePassphrase("  MeG ") === "meg");
  assert("non-string → empty", normalizePassphrase(false) === "");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
