// Source-text lock-screen UX for src/LoginGate.jsx.
// LoginGateScreen is an unexported JSX closure (same convention as
// tests/test_review_panel.mjs / test_meg_homescreen.mjs): assert the
// shipped markup, do not invent a parallel component.
//
// Scope: UI-only. Auth matching still lives in src/loginGate.js and is
// covered by tests/test_login_gate.mjs — this file must not rewrite it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/LoginGate.jsx"), "utf8");
const AUTH = readFileSync(join(HERE, "../src/loginGate.js"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

console.log("=== boxed full-width passphrase field ===");
{
  assert("field wrapper is full width",
    /data-testid="login-gate-field"[\s\S]*?width:\s*"100%"/.test(SRC));
  assert("field is boxed on all sides, not underline-only",
    /data-testid="login-gate-field"[\s\S]*?border:\s*error[\s\S]*?0\.5px solid var\(--color-border-secondary\)/.test(SRC)
    && !/login-gate-input[\s\S]*?borderBottom:/.test(SRC));
  assert("box uses existing radius token",
    /data-testid="login-gate-field"[\s\S]*?borderRadius:\s*"var\(--border-radius-md\)"/.test(SRC));
  assert("input stays 16px to avoid iOS focus-zoom",
    /data-testid="login-gate-input"[\s\S]*?fontSize:\s*"16px"/.test(SRC));
}

console.log("=== placeholder ===");
{
  assert("placeholder is Household word",
    SRC.includes('placeholder="Household word"'));
}

console.log("=== Unlock disabled when empty ===");
{
  assert("canUnlock is trim-length",
    SRC.includes("const canUnlock = value.trim().length > 0"));
  assert("submit button is disabled when empty",
    /data-testid="login-gate-submit"[\s\S]*?disabled=\{!canUnlock\}/.test(SRC));
  assert("empty submit is a no-op (does not call unlockGate)",
    /if \(!canUnlock\) return;/.test(SRC));
}

console.log("=== inline error keeps calm copy ===");
{
  assert("failed unlock still uses the calm copy",
    SRC.includes('setError("That word isn’t recognized. Try again.")'));
  assert("error renders inline under the field with role=alert",
    /data-testid="login-gate-error"[\s\S]*?role="alert"/.test(SRC));
  assert("error is wired to the input via aria-describedby",
    SRC.includes('aria-describedby={error ? "login-gate-error" : undefined}'));
}

console.log("=== optional show/hide toggle ===");
{
  assert("visibility toggle is a non-submit button on the field",
    /data-testid="login-gate-visibility"[\s\S]*?type="button"/.test(SRC)
    || /type="button"[\s\S]*?data-testid="login-gate-visibility"/.test(SRC));
  assert("toggle flips input type between password and text",
    SRC.includes('type={visible ? "text" : "password"}'));
  assert("toggle labels are Show / Hide",
    SRC.includes("{visible ? \"Hide\" : \"Show\"}"));
}

console.log("=== auth logic is unchanged ===");
{
  assert("UI still calls unlockGate(value) — no new matcher",
    SRC.includes("const id = unlockGate(value);"));
  assert("loginGate.js still owns GATE_WORDS",
    AUTH.includes('export const GATE_WORDS = Object.freeze(["travel", "meg"])'));
  assert("no Cloudflare Access / secrets wiring in the gate UI",
    !/CF_ACCESS|CLOUDFLARE_ACCESS|secret|Access-Client/i.test(SRC));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
