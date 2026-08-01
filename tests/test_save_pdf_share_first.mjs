// Tests for src/pdf/savePdfShareFirst.js — the share-first PDF save path.
//
// Unlike most suites here this one imports the real module and calls it. The
// helper is plain JS with no React import, so it loads in a bare node script;
// `navigator` is undefined in Node 20 and not a defined global property, so
// each case can install its own stub and delete it afterwards.
//
// What this locks in:
//   1. When the Share Sheet is available and succeeds, we do NOT also download.
//   2. AbortError (user dismissed the sheet) does NOT download — the whole
//      point is to stop putting files where the user didn't ask for them.
//   3. Any OTHER share failure DOES download, so the file is never lost.
//   4. No file-share support → download immediately.
//   5. No `navigator` at all (SSR / node) → download, no crash.
//   6. The shared payload is a File named for the PDF, typed application/pdf.

import { savePdfShareFirst } from "../src/pdf/savePdfShareFirst.js";

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

const FILENAME = "routesmith-porto.pdf";

// Minimal jsPDF stand-in: only the two methods the helper touches.
function makePdfDoc() {
  const calls = { output: [], save: [] };
  return {
    calls,
    output(type) { calls.output.push(type); return new Blob(["%PDF-1.4 fake"], { type: "application/pdf" }); },
    save(name) { calls.save.push(name); },
  };
}

// Installs a navigator stub for one case and returns what it recorded.
// `canShare` may be a boolean (shorthand) or a function; `share` is the
// implementation to run, or null to omit the method entirely.
function withNavigator({ canShare, share }, fn) {
  const seen = { canShareArgs: [], shareArgs: [] };
  const nav = {};
  if (canShare !== undefined) {
    nav.canShare = typeof canShare === "function" ? canShare : (arg) => { seen.canShareArgs.push(arg); return canShare; };
  }
  if (share) nav.share = (arg) => { seen.shareArgs.push(arg); return share(arg); };
  globalThis.navigator = nav;
  return fn().finally(() => { delete globalThis.navigator; }).then(() => seen);
}

// --- 1. Share succeeds → no download --------------------------------------
console.log("\n[share succeeds]");
{
  const pdf = makePdfDoc();
  const seen = await withNavigator(
    { canShare: true, share: () => Promise.resolve() },
    () => savePdfShareFirst(pdf, FILENAME)
  );
  assert("pdf.save() is NOT called when the share resolves", pdf.calls.save.length === 0, `save calls: ${pdf.calls.save.length}`);
  assert("navigator.share() called exactly once", seen.shareArgs.length === 1, `share calls: ${seen.shareArgs.length}`);
  assert("blob pulled via output(\"blob\")", pdf.calls.output.join(",") === "blob", pdf.calls.output.join(","));

  // --- 6. Payload shape (asserted here, where a successful share ran) -----
  const payload = seen.shareArgs[0] || {};
  const file = (payload.files || [])[0];
  assert("share payload carries exactly one file", (payload.files || []).length === 1);
  assert("the payload is a File", file instanceof File, String(file));
  assert("file MIME type is application/pdf", file?.type === "application/pdf", file?.type);
  assert("file is named for the PDF", file?.name === FILENAME, file?.name);
  assert("share payload sets title (iOS sheet header)", payload.title === FILENAME, String(payload.title));
  assert("canShare was probed with the same file shape", seen.canShareArgs.length === 1 && (seen.canShareArgs[0].files || []).length === 1);
}

// --- 2. User cancelled → no download --------------------------------------
console.log("\n[user dismisses the sheet]");
{
  const pdf = makePdfDoc();
  await withNavigator(
    { canShare: true, share: () => Promise.reject(Object.assign(new Error("share canceled"), { name: "AbortError" })) },
    () => savePdfShareFirst(pdf, FILENAME)
  );
  assert("pdf.save() is NOT called on AbortError", pdf.calls.save.length === 0, `save calls: ${pdf.calls.save.length}`);
}

// --- 3. Share fails for any other reason → download -----------------------
console.log("\n[share fails for a non-cancel reason]");
{
  const pdf = makePdfDoc();
  await withNavigator(
    { canShare: true, share: () => Promise.reject(new Error("NotAllowedError: user activation expired")) },
    () => savePdfShareFirst(pdf, FILENAME)
  );
  assert("pdf.save() IS called on a generic share failure", pdf.calls.save.length === 1, `save calls: ${pdf.calls.save.length}`);
  assert("fallback download uses the same filename", pdf.calls.save[0] === FILENAME, pdf.calls.save[0]);
}

// A rejection with no `name` must not be mistaken for a cancel.
{
  const pdf = makePdfDoc();
  await withNavigator(
    { canShare: true, share: () => Promise.reject("string rejection") },
    () => savePdfShareFirst(pdf, FILENAME)
  );
  assert("a non-Error rejection still falls back to download", pdf.calls.save.length === 1, `save calls: ${pdf.calls.save.length}`);
}

// --- 4. Files not shareable → download immediately ------------------------
console.log("\n[canShare rejects file payloads]");
{
  const pdf = makePdfDoc();
  const seen = await withNavigator(
    { canShare: false, share: () => Promise.resolve() },
    () => savePdfShareFirst(pdf, FILENAME)
  );
  assert("pdf.save() IS called when canShare returns false", pdf.calls.save.length === 1, `save calls: ${pdf.calls.save.length}`);
  assert("navigator.share() is never invoked", seen.shareArgs.length === 0, `share calls: ${seen.shareArgs.length}`);
}

// Browsers that expose share() but not canShare() must not be trusted with files.
{
  const pdf = makePdfDoc();
  const seen = await withNavigator(
    { canShare: undefined, share: () => Promise.resolve() },
    () => savePdfShareFirst(pdf, FILENAME)
  );
  assert("pdf.save() IS called when canShare is missing entirely", pdf.calls.save.length === 1, `save calls: ${pdf.calls.save.length}`);
  assert("share() is not called without a canShare probe", seen.shareArgs.length === 0, `share calls: ${seen.shareArgs.length}`);
}

// --- 5. No navigator at all (SSR / node) ----------------------------------
console.log("\n[navigator absent]");
{
  const pdf = makePdfDoc();
  delete globalThis.navigator;
  let threw = null;
  try { await savePdfShareFirst(pdf, FILENAME); } catch (err) { threw = err; }
  assert("does not throw when navigator is undefined", threw === null, String(threw));
  assert("pdf.save() IS called", pdf.calls.save.length === 1, `save calls: ${pdf.calls.save.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
