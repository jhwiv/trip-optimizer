// Which closed-on-this-day signal wins on a restaurant card.
//
// Two mechanisms can independently claim a restaurant is shut on the day it
// was scheduled:
//
//   1. `_weekdayMismatch` — the *model's* own `open_days` field cross-checked
//      against the computed weekday (applyQualityLayer, App.jsx).
//   2. a `CLOSED_ON_THIS_DAY` entry in `flags[]` — Google Places' posted
//      `weekdayDescriptions` (decorateVenue, placesVerify.js).
//
// Places is authoritative (CLAUDE.md: "on conflict, Places wins"), so when it
// has an opinion the model's chip is suppressed rather than rendered next to
// it. Two chips saying the same thing is noise; two disagreeing is worse.
//
// Pure and dependency-free so the card's chip logic is testable without a DOM.

const DAY_ABBR = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };

// Accepts both shapes in play: "mon" (_weekdayMismatch) and "Monday"
// (dayContext.weekday, which is what the Places flag carries).
function abbrevWeekday(weekday) {
  if (!weekday || typeof weekday !== "string") return null;
  return DAY_ABBR[weekday.slice(0, 3).toLowerCase()] || null;
}

// Returns { source, severity, label, title } or null when the restaurant has
// no closure signal. `label` is chip-sized; the full sentence lives in `title`
// because the chip is nowrap and the flag messages are prose.
export function pickClosureChip(restaurant) {
  if (!restaurant || typeof restaurant !== "object") return null;

  const flags = Array.isArray(restaurant.flags) ? restaurant.flags : [];
  const places = flags.find((f) => f && f.code === "CLOSED_ON_THIS_DAY");
  if (places) {
    const day = abbrevWeekday(places.weekday);
    return {
      source: "places",
      // Anchor bookings block the export (#147); everything else warns.
      severity: places.severity === "block" ? "block" : "warn",
      label: day ? `Closed ${day}` : "Closed this day",
      title: places.message || "Closed on this day per Google Places hours.",
    };
  }

  const mismatch = restaurant._weekdayMismatch;
  if (mismatch) {
    const day = abbrevWeekday(mismatch) || mismatch;
    return {
      source: "model",
      severity: "warn",
      label: `Closed ${day}`,
      title: `This plan's own open-days data says the venue is closed ${day}s. Not confirmed against Google Places — verify hours.`,
    };
  }

  return null;
}
