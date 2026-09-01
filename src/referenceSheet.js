// Phone-ready reference sheet — a compact, curated list of ONLY the
// hard-to-replace reservations and contacts in a plan.
//
// ROUTESMITH ITINERARY-QUALITY UPGRADE spec, §13: "Keep Routesmith's
// existing provider/contact information. At the end of the itinerary,
// create a compact reference sheet containing ONLY the hard-to-replace
// reservations and contacts... Do not clutter this section with every
// restaurant and attraction in the trip."
//
// No new model output needed — every field this pulls from already exists
// in the plan schema (hotel/restaurant/contact objects the model already
// writes). This is a pure client-side aggregation + curation pass; nothing
// here is fabricated or inferred beyond what the model already wrote.
//
// Deliberate scope for this first pass (documented, not guessed at — same
// posture as applyQualityLayer §2e's own "known ceiling" comment in
// src/App.jsx): includes every Hotel item (always mission-critical, never
// clutter) and Transport items carrying real contact info (private
// drivers, transfers, rental cars — the build prompt already requires
// contact on every meaningful Transport item), plus restaurants with an
// ACTUAL reservation (reservation.platform !== "walkin" — the one
// structural signal distinguishing "a real booking exists" from "a casual
// recommendation," the closest available proxy for "destination
// restaurant" vs. clutter). Activity-item private guides/boat operators
// are NOT separated out from ordinary sightseeing activities in this
// pass — there is no structural field distinguishing them, and a
// text-heuristic guess risks either missing real guides or pulling in
// ordinary museum visits; left as a documented gap rather than guessed at.
//
// Pure: no network, no React, no module state.

export function buildReferenceSheet(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const entries = [];
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    items.forEach((item) => {
      if (item?.type === "Hotel" && item.hotel?.name) {
        entries.push({
          kind: "Hotel",
          name: item.hotel.name,
          phone: item.hotel.phone || "",
          address: item.hotel.address || "",
          website: item.hotel.website || "",
          day: dayIdx + 1,
        });
      } else if (item?.type === "Transport" && item.contact && (item.contact.phone || item.contact.website)) {
        entries.push({
          kind: "Transport",
          name: String(item.text || "Transport").trim(),
          phone: item.contact.phone || "",
          address: item.contact.address || "",
          website: item.contact.website || "",
          day: dayIdx + 1,
        });
      } else if (
        item?.restaurant?.name &&
        item.restaurant.reservation?.platform &&
        item.restaurant.reservation.platform !== "walkin"
      ) {
        entries.push({
          kind: "Restaurant",
          name: item.restaurant.name,
          phone: item.restaurant.contact?.phone || item.restaurant.reservation?.phone || "",
          address: item.restaurant.contact?.address || "",
          website: item.restaurant.contact?.website || "",
          day: dayIdx + 1,
        });
      }
    });
  });
  // De-dupe by kind+name (a hotel spanning check-in and check-out days, or
  // a transport contact repeated across legs, shouldn't produce two rows).
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.kind}:${e.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
