// Pure helpers behind the in-app Introduction generation feature.
//
// The Introduction (page 2 of the PDF — see renderIntroduction in
// src/pdf/itineraryPdf.js) was historically generated inside the streaming
// build, then removed (PR #20) because it added ~600 output tokens and
// contributed to max_tokens truncations. It is now produced by a SEPARATE,
// lightweight post-build call to /api/introduction, then persisted onto the
// plan exactly like the manual paste box does (data.introduction = { arc,
// differentiators }).
//
// Network lives in App.jsx (IntroductionPasteCard) and the /api/introduction
// Cloudflare function. The functions here are pure so they can be unit-tested
// without network: request shaping from a finished plan, normalization of the
// model response into { arc, differentiators }, and the no-clobber auto-fill
// gate that protects a user-pasted/edited introduction.

export const NONE_FLAGGED = "NONE_FLAGGED";

// True when the plan already carries a non-empty introduction (arc or
// differentiators present after trimming). Gate for auto-generation: we only
// auto-fill when the plan has no introduction yet, so an explicit paste/edit
// is never overwritten by a passive auto-run.
export function hasIntroduction(plan) {
  const intro = plan && plan.introduction;
  if (!intro || typeof intro !== "object") return false;
  const arc = typeof intro.arc === "string" ? intro.arc.trim() : "";
  const diff = typeof intro.differentiators === "string" ? intro.differentiators.trim() : "";
  return !!(arc || diff);
}

// Auto-generation gate: only when there's a renderable plan (has days) and no
// existing introduction. Explicit regenerate bypasses this via the `force`
// flag on applyGeneratedIntroduction.
export function shouldAutoGenerateIntroduction(plan) {
  if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) return false;
  return !hasIntroduction(plan);
}

// Shape the request payload sent to /api/introduction from a finished plan +
// the trip inputs. Mirrors the trip-fact gathering of the paste card's
// "Copy AI prompt" builder, but emits structured data (not a prompt) so the
// endpoint can compose the grounded prompt server-side. Only data that is
// actually in the plan is forwarded — the endpoint is instructed to invent
// nothing beyond it.
export function shapeIntroRequest(plan, inputs) {
  const p = plan && typeof plan === "object" ? plan : {};
  const basics = inputs && inputs.basics && typeof inputs.basics === "object" ? inputs.basics : {};

  const cities = Array.isArray(p.cities) ? p.cities : [];
  const route =
    cities.length >= 2
      ? cities.map((c) => String(c?.name || "").trim()).filter(Boolean).join(" → ")
      : "";

  const startDate = String(basics.startDate || "").trim();
  const endDate = String(basics.endDate || "").trim();
  const dates = startDate && endDate ? `${startDate} — ${endDate}` : startDate;

  const days = Array.isArray(p.days) ? p.days : [];
  const dayLines = days
    .map((d, i) => {
      const label = String(d?.label || `Day ${i + 1}`).trim();
      const headline = String(d?.headline || "").trim();
      const items = Array.isArray(d?.items) ? d.items : [];
      // Top few named items so the endpoint knows what's actually scheduled.
      const namedItems = items
        .filter((it) => it && (it.type === "Activity" || it.type === "Dinner" || it.type === "Hotel"))
        .map((it) => String(it.text || it.name || "").trim())
        .filter(Boolean)
        .slice(0, 3)
        .join("; ");
      const tail = [headline, namedItems].filter(Boolean).join(" — ");
      return `${label}${tail ? ": " + tail : ""}`;
    })
    .filter(Boolean);

  const flags = Array.isArray(p.flags)
    ? p.flags.slice(0, 4).map((f) => String(f || "").trim()).filter(Boolean)
    : [];

  return {
    destination: String(p.destination || "").trim(),
    route,
    nights: String(basics.nights || "").trim(),
    dates,
    travelers: String(basics.travelers || "").trim(),
    style: Array.isArray(basics.style) ? basics.style.filter(Boolean).join(", ") : "",
    pace: String(basics.pace || "").trim(),
    budget: String(basics.budget || "").trim(),
    days: dayLines,
    flags,
  };
}

// Normalize a raw model/tool response into the { arc, differentiators } shape
// the PDF renderer + paste box consume. Returns null when unusable (no arc)
// so the caller can surface an honest error instead of persisting an empty
// introduction.
//
// Rules:
//   • arc is required and must be non-empty after trimming; otherwise null.
//   • differentiators is optional: empty stays "" (Part 2 omitted on the PDF),
//     and the literal NONE_FLAGGED (any case / surrounding whitespace) is
//     canonicalized so the renderer shows its honest "no differentiators" note.
export function normalizeIntroduction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const arc = typeof raw.arc === "string" ? raw.arc.trim() : "";
  if (!arc) return null;
  const diffRaw = typeof raw.differentiators === "string" ? raw.differentiators.trim() : "";
  let differentiators;
  if (!diffRaw) differentiators = "";
  else if (diffRaw.toUpperCase() === NONE_FLAGGED) differentiators = NONE_FLAGGED;
  else differentiators = diffRaw;
  return { arc, differentiators };
}

// Build the next plan with the generated introduction applied, honoring the
// no-clobber precedence. Returns the SAME plan reference (unchanged) when the
// write is blocked — either the response was unusable or an existing user
// introduction would be clobbered on a passive auto-run — so the caller can
// skip onPlanRevised by identity (`next === plan`). `force` (explicit
// regenerate) bypasses the no-clobber guard.
export function applyGeneratedIntroduction(plan, generated, { force = false } = {}) {
  const norm = normalizeIntroduction(generated);
  if (!norm) return plan; // unusable response — leave the plan untouched
  if (!force && hasIntroduction(plan)) return plan; // never clobber a user intro on auto-run
  return { ...plan, introduction: { arc: norm.arc, differentiators: norm.differentiators } };
}

// PDF-download gate.
//
// PR #69 made the trip introduction PDF-only, which created a race: the
// headless IntroductionAutoGenerator fires POST /api/introduction in a
// useEffect after the plan finishes building, and a fast user can click
// Save as PDF before the response writes data.introduction back onto the
// plan. That ships a PDF with no Part 1 / Part 2 intro page.
//
// This helper centralizes the gate logic so both the button and the tests
// agree on the rule. The PDF download is READY when either:
//   (a) the plan already carries a usable introduction (success path), OR
//   (b) the generator is not currently running AND the plan didn't need an
//       introduction in the first place (no days, or auto-gen disabled), OR
//   (c) the generator already attempted and finished — success wrote (a);
//       failure leaves no introduction but releases the gate so the user is
//       never trapped behind a permanently failed silent generation.
//
// Inputs:
//   plan         — the source-of-truth plan (rawData in ItineraryView). The
//                  generator persists onto plan.introduction via onPlanRevised.
//   isGenerating — boolean exposed by IntroductionAutoGenerator through
//                  onGeneratingChange. true while the /api/introduction fetch
//                  is in flight; flips to false on resolve OR reject so the
//                  gate doesn't hang on a silent failure.
//
// Returns: { ready: boolean, label: string }
//   label is the button text to show when ready === false. The caller passes
//   it through to the existing busy-state label slot so disabled styling and
//   aria-label flow through unchanged.
export function isPdfDownloadReady({ plan, isGenerating } = {}) {
  if (hasIntroduction(plan)) return { ready: true, label: "" };
  if (isGenerating) return { ready: false, label: "Preparing introduction…" };
  // Not generating and no intro: either generation isn't needed for this
  // plan (no days), or it already attempted and finished (success would
  // have written an intro; failure releases the gate). Either way, allow
  // the download — a failed intro must never block the PDF.
  return { ready: true, label: "" };
}
