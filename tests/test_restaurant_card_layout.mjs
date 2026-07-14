// Guard test for the restaurant-card header layout fix.
//
// Bug: on narrow phones a restaurant name like "De Jonkman" rendered one
// letter per line. The header is a flex row [meal badge][name][warning pills];
// the name column (flex:1) collapsed toward zero width and the GLOBAL
// `overflow-wrap: anywhere` rule in index.html then broke the name at every
// character.
//
// Fix contract (verified statically here; rendered behavior is verified in a
// browser separately):
//   1. index.html defines `.rc-header` (flex row) and `.rc-name` with
//      `min-width: 0` + `word-break: normal` + `overflow-wrap: break-word`, so
//      the name wraps at WORD boundaries and can shrink without stacking.
//   2. index.html has a `@media (max-width: 600px)` block that gives `.rc-name`
//      full width and `order: -1`, stacking the name ABOVE the badge row.
//   3. App.jsx applies those classes to the restaurant-card header + name and
//      no longer pins the name with an inline `flex: 1`.
//   4. The closed-day pill reads title case ("Closed Mon"), NOT the shouty
//      "CLOSED MONS — VERIFY" (no textTransform:uppercase, no "— verify").
//
// Pure Node string assertions — no browser, matches the existing suite style.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = join(HERE, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "src", "App.jsx"), "utf8");

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Collapse whitespace so we can match CSS declarations regardless of formatting.
const htmlFlat = html.replace(/\s+/g, " ");

console.log("=== index.html: .rc-name wraps at word boundaries ===");
const rcNameMatch = htmlFlat.match(/\.rc-name\s*\{([^}]*)\}/);
assert(".rc-name rule exists", !!rcNameMatch, "no .rc-name block found");
const rcName = rcNameMatch ? rcNameMatch[1] : "";
assert(".rc-name sets min-width: 0", /min-width:\s*0/.test(rcName), rcName);
assert(".rc-name sets word-break: normal", /word-break:\s*normal/.test(rcName), rcName);
assert(".rc-name sets overflow-wrap: break-word", /overflow-wrap:\s*break-word/.test(rcName), rcName);

console.log("=== index.html: .rc-header is a flex row ===");
const rcHeaderMatch = htmlFlat.match(/\.rc-header\s*\{([^}]*)\}/);
assert(".rc-header rule exists", !!rcHeaderMatch, "no .rc-header block found");
const rcHeader = rcHeaderMatch ? rcHeaderMatch[1] : "";
assert(".rc-header is display:flex", /display:\s*flex/.test(rcHeader), rcHeader);
assert(".rc-header wraps", /flex-wrap:\s*wrap/.test(rcHeader), rcHeader);

console.log("=== index.html: mobile stacks name above badges ===");
const mq = htmlFlat.match(/@media\s*\(max-width:\s*600px\)\s*\{(.*?\.rc-name\s*\{[^}]*\}.*?)\}/);
assert("@media(max-width:600px) block styles .rc-name", !!mq, "no matching media query found");
if (mq) {
  const mqBody = mq[1];
  const mqName = (mqBody.match(/\.rc-name\s*\{([^}]*)\}/) || [])[1] || "";
  assert("mobile .rc-name is full width", /width:\s*100%/.test(mqName) || /flex:\s*1 1 100%/.test(mqName), mqName);
  assert("mobile .rc-name uses order:-1 (name on top)", /order:\s*-1/.test(mqName), mqName);
}

console.log("=== App.jsx: card header + name use the classes ===");
assert('header uses className="rc-header"', /className="rc-header"/.test(app));
assert('name uses className="rc-name"', /className="rc-name"/.test(app));
// The name <p> must not re-pin flex:1 inline (that would defeat the mobile
// full-width override and re-enable the squeeze).
const nameLine = (app.split(/\r?\n/).find((l) => l.includes('className="rc-name"'))) || "";
assert('name <p> drops inline flex:1', !/flex:\s*1\b/.test(nameLine), nameLine);
assert("name <p> renders r.name", /className="rc-name"[^]*?\{r\.name\}/.test(app) || nameLine.includes("{r.name}"), nameLine);

console.log("=== App.jsx: closed-day pill is title case, not shouty ===");
// Pill still communicates closure, now as "Closed {Mon}".
assert('renders "Closed {DAY_LABELS_3...}"', /Closed \{DAY_LABELS_3\[r\._weekdayMismatch\]/.test(app));
// Isolate the two rendered closed-day pill spans (header + backup). Match only
// JSX <span> lines, not internal warning-log strings that also mention "verify
// hours". Neither pill may force uppercase or carry the old "— verify" shout.
const closedPillLines = app
  .split(/\r?\n/)
  .filter((l) => /Closed \{DAY_LABELS_3/.test(l) && l.includes("<span"));
assert("found both closed-day pills", closedPillLines.length === 2, `found ${closedPillLines.length}`);
for (const line of closedPillLines) {
  assert("closed-day pill drops textTransform:uppercase", !/textTransform:\s*"uppercase"/.test(line), line);
  assert('closed-day pill drops "— verify" shout', !/— verify/.test(line), line);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
