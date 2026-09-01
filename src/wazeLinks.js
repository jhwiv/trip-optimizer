// Waze routing links for meaningful driving legs.
//
// ROUTESMITH ITINERARY-QUALITY UPGRADE spec, §10 "ADD CLICKABLE WAZE
// ROUTING": "For meaningful driving legs, retain Routesmith's existing
// drive-time information and add a clickable Waze icon/link... Do not add
// Waze links for trivial short city movements."
//
// Deliberately reuses driveTimeVerify.js's collectDriveLegs wholesale for
// the "is this a meaningful driving leg" classification rather than writing
// a second one: that module already scopes to genuine point-to-point drives
// (car/taxi/rideshare/private transfer, never train/ferry/flight/walk),
// requires a claimed duration of 45+ minutes (the same "not a trivial short
// hop" floor this spec section asks for), and already extracts a
// destination place name from the item's own text. A meaningful drive leg
// worth checking real-world drive time against is exactly a meaningful
// drive leg worth a Waze link — same leg, two different uses of it.
//
// Pure: no network, no React, no module state.

import { collectDriveLegs } from "./driveTimeVerify.js";

// Waze's "universal link" deep-link form. A bare destination query string
// (no coordinates required) is enough — Waze resolves it the same way a
// typed search would. Falls back gracefully to nothing when there's no
// usable destination text.
export function buildWazeUrl(destination) {
  const q = String(destination || "").trim();
  if (!q) return "";
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
}

// Returns a Map keyed `${dayIdx}:${itemIdx}` -> Waze URL, one entry per
// drive leg collectDriveLegs finds meaningful. `cityHint` is passed through
// unchanged (see collectDriveLegs's own doc comment).
export function collectWazeLinks(plan, cityHint) {
  const legs = collectDriveLegs(plan, cityHint);
  const out = new Map();
  for (const leg of legs) {
    const url = buildWazeUrl(leg.destination);
    if (url) out.set(`${leg.dayIdx}:${leg.itemIdx}`, url);
  }
  return out;
}
