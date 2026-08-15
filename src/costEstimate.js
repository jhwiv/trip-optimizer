// Trip-level cost estimate — a rough total + category breakdown.
//
// This app has no live pricing/booking API, so cost_estimate is the model's
// own approximation based on the flights/hotel tier/dining/activities
// actually in the plan — framed explicitly as an ESTIMATE, never a quote,
// the same way weather_window is allowed to describe seasonal norms without
// claiming to be a live forecast (see CLAUDE.md's verification-discipline
// rule: price is verify-or-strip for a SPECIFIC venue's posted price, but
// there is no equivalent "verify" step for a whole-trip total — it is
// inherently an estimate, not a fact to check).
//
// normalizeCostEstimate() only guards against obviously broken SHAPES (a
// missing currency, low/high emitted backwards, a non-finite amount) — it
// cannot and does not verify whether the numbers themselves are realistic.
//
// Pure: no network, no React, no module state.

const CURRENCY_SYMBOLS = {
  USD: "$", CAD: "$", AUD: "$", NZD: "$", SGD: "$", HKD: "$", MXN: "$",
  EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹",
  KRW: "₩", THB: "฿", BRL: "R$", ZAR: "R", CHF: "CHF ",
};

function currencySymbol(code) {
  const c = String(code || "USD").trim().toUpperCase();
  return CURRENCY_SYMBOLS[c] || `${c} `;
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// Whole-currency amounts only (the schema asks the model for integers) —
// round and floor-at-zero rather than reject an entire estimate over one
// odd field (e.g. a stray "3000.5" or a model-emitted negative).
function cleanAmount(n) {
  if (isFiniteNumber(n)) return Math.max(0, Math.round(n));
  if (typeof n === "string" && n.trim() && Number.isFinite(Number(n))) {
    return Math.max(0, Math.round(Number(n)));
  }
  return null;
}

function normalizeRange(low, high) {
  let lo = cleanAmount(low);
  let hi = cleanAmount(high);
  if (lo == null && hi == null) return null;
  if (lo == null) lo = hi;
  if (hi == null) hi = lo;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  return { low: lo, high: hi };
}

// Validates + repairs a raw cost_estimate object from the model. Returns
// null when the shape is unusable (no low/high anywhere) rather than
// shipping a broken "$NaN-$NaN" to the screen or PDF.
export function normalizeCostEstimate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const range = normalizeRange(raw.low, raw.high);
  if (!range) return null;

  const currency = typeof raw.currency === "string" && raw.currency.trim()
    ? raw.currency.trim().toUpperCase()
    : "USD";

  const breakdown = Array.isArray(raw.breakdown)
    ? raw.breakdown
        .map((b) => {
          if (!b || typeof b !== "object") return null;
          const category = typeof b.category === "string" ? b.category.trim() : "";
          const bRange = normalizeRange(b.low, b.high);
          if (!category || !bRange) return null;
          return { category, low: bRange.low, high: bRange.high };
        })
        .filter(Boolean)
    : [];

  const basis = typeof raw.basis === "string" ? raw.basis.trim() : "";

  return { currency, low: range.low, high: range.high, breakdown, basis };
}

// "$3,200" — en-US thousands grouping regardless of currency, matching how
// every other dollar figure in this app is already formatted.
export function formatCostAmount(amount, currency) {
  const n = cleanAmount(amount);
  if (n == null) return "";
  return currencySymbol(currency) + n.toLocaleString("en-US");
}

// "$3,200-$4,800" or, when low === high, just "$3,200".
export function formatCostRange(estimate) {
  if (!estimate) return "";
  const { currency, low, high } = estimate;
  if (low == null || high == null) return "";
  if (low === high) return formatCostAmount(low, currency);
  return `${formatCostAmount(low, currency)}–${formatCostAmount(high, currency)}`;
}

export function formatBreakdownLine(item, currency) {
  if (!item) return "";
  const range = item.low === item.high
    ? formatCostAmount(item.low, currency)
    : `${formatCostAmount(item.low, currency)}–${formatCostAmount(item.high, currency)}`;
  return `${item.category}: ${range}`;
}
