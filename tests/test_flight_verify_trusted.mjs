// Tests for the _verifyTrusted honesty signal in renderFlightBlock
// (src/pdf/itineraryPdf.js).
//
// _verifyTrusted is set by the App.jsx verify-fallback branch
// (src/App.jsx:6990-7001) when /api/flights-search couldn't confirm or
// substitute a model-emitted flight. The pipeline keeps the model's
// depart_time/arrive_time/duration as a last resort so applyQualityLayer's
// strip doesn't null the flight number and leave a blank card. Those times
// can be internally inconsistent (real observed case: DL9374 "5:05 PM →
// 8:25 PM · 10h 20m" — mathematically impossible in any timezone).
//
// The fix: when fl._verifyTrusted === true, drop the duration from the
// headline (don't propagate an inconsistent-with-itself value) and swap
// the "Verify" qualifier for a stronger, times-inclusive nudge that says
// BOTH the number AND the times are unconfirmed.
//
// Because renderFlightBlock draws to a jsPDF context, we don't exercise it
// end-to-end here — that's the rendered-PDF spot check. Instead we test the
// pure logic that decides what gets shown: the headline-assembly branch on
// duration inclusion, and the Verify-copy selection.
//
// These are white-box tests against the observable renderer behavior. When
// renderFlightBlock changes shape, update the fixtures to match.

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail); }
}

// Mirror the renderer's logic without importing the jsPDF-coupled module:
// - Headline duration is included iff (!_verifyTrusted && fl.duration).
// - Verify copy is the stronger string iff fl._verifyTrusted === true.
// - Aircraft line is suppressed iff _verifyTrusted (model may have fabricated it too).
function assembleHeadlineDuration(fl) {
  const _verifyTrusted = fl._verifyTrusted === true;
  return (!_verifyTrusted && fl.duration) ? fl.duration : null;
}
function verifyCopy(fl) {
  const _verifyTrusted = fl._verifyTrusted === true;
  return _verifyTrusted
    ? "Flight number and times could not be confirmed against the live schedule — verify all details directly with the airline before booking."
    : "Flight number is the scheduled operating flight — confirm at booking.";
}
function showsAircraft(fl) {
  return !!(fl.aircraft && !(fl._verifyTrusted === true));
}

console.log("=== headline duration inclusion ===");
{
  // Confirmed flight (real schedule confirmation): duration shown.
  const fl = { flight_number: "UA1234", duration: "5h 20m", _scheduleVerified: true, _verifyTrusted: false };
  assert("confirmed flight shows duration on headline",
    assembleHeadlineDuration(fl) === "5h 20m",
    assembleHeadlineDuration(fl));
}
{
  // Verify-trusted flight (fallback case): duration dropped.
  const fl = { flight_number: "DL9374", duration: "10h 20m", _scheduleVerified: true, _verifyTrusted: true };
  assert("verify-trusted flight drops duration from headline",
    assembleHeadlineDuration(fl) === null,
    String(assembleHeadlineDuration(fl)));
}
{
  // Confirmed flight with no duration: nothing to drop.
  const fl = { flight_number: "UA1234", _scheduleVerified: true };
  assert("confirmed flight with no duration → null",
    assembleHeadlineDuration(fl) === null);
}
{
  // Unconfirmed but not verify-trusted (e.g. user-supplied flight, no resolver run):
  // duration still shown as-is (no _verifyTrusted signal to suppress it).
  const fl = { flight_number: "UA1234", duration: "5h 20m" };
  assert("no _verifyTrusted flag → duration shown",
    assembleHeadlineDuration(fl) === "5h 20m");
}

console.log("=== Verify qualifier copy selection ===");
{
  // Confirmed flight: standard qualifier.
  const fl = { flight_number: "UA1234", _scheduleVerified: true, _verifyTrusted: false };
  assert("confirmed flight → standard verify copy",
    verifyCopy(fl) === "Flight number is the scheduled operating flight — confirm at booking.");
}
{
  // Verify-trusted flight (real Amsterdam→Bruges DL9374 case): stronger copy.
  const fl = { flight_number: "DL9374", _scheduleVerified: true, _verifyTrusted: true };
  const copy = verifyCopy(fl);
  assert("verify-trusted flight → stronger verify copy",
    copy.includes("could not be confirmed") && copy.includes("times"),
    copy);
}
{
  // No _verifyTrusted flag: standard copy.
  const fl = { flight_number: "UA1234" };
  assert("no flag → standard verify copy",
    verifyCopy(fl) === "Flight number is the scheduled operating flight — confirm at booking.");
}
{
  // _verifyTrusted set to a truthy non-true value (e.g. "yes"): NOT triggered.
  // The guard uses strict === true to prevent accidental triggers.
  const fl = { flight_number: "UA1234", _verifyTrusted: "yes" };
  assert("_verifyTrusted must be strict true (not truthy)",
    verifyCopy(fl) === "Flight number is the scheduled operating flight — confirm at booking.");
}

console.log("=== Aircraft line suppression ===");
{
  const fl = { flight_number: "UA1234", aircraft: "Boeing 787-9" };
  assert("confirmed flight with aircraft → shown",
    showsAircraft(fl) === true);
}
{
  const fl = { flight_number: "DL9374", aircraft: "Airbus A330-300", _verifyTrusted: true };
  assert("verify-trusted flight with aircraft → suppressed",
    showsAircraft(fl) === false);
}
{
  const fl = { flight_number: "UA1234" };
  assert("no aircraft field → nothing to show",
    showsAircraft(fl) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
