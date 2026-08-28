// Independent-source hotel brand-claim verification (added 2026-08-28).
//
// applyQualityLayer's §2e loyalty-fabrication check (src/App.jsx) catches a
// CROSS-chain claim — two different chains named together, which can never
// be true since no two major hotel loyalty programs have real reciprocity.
// Its own comment documents the ceiling this module closes: a DIRECT claim
// that an independently-named hotel simply IS a specific chain's own
// sub-brand (The Yeatman / Villa Lara both mislabeled "Marriott Tribute
// Portfolio," no second chain named) has no second chain for that check to
// catch — an independent hotel's name carries no brand keyword to compare
// against ITS OWN claim.
//
// This module cross-checks the claim against Tripadvisor's independent
// listing instead: if a confidently-resolved match's own name+description
// never mentions the claimed chain at all, that's evidence worth surfacing
// — not proof (a terse listing might just omit loyalty-program language
// for a real property), so this stays a cautious warn, mirroring §2e's own
// "warn-only, never mutates" posture.
//
// Pure client-side logic — no network. The actual Tripadvisor calls live
// server-side in functions/api/tripadvisor-verify.js. Architecture mirrors
// src/driveTimeVerify.js exactly: collect candidates → an async hook POSTs
// them → a merge step turns verdicts into item.flags entries (the same
// array §2e already pushes onto, and HotelCard already renders — see
// KNOWN FAILURE MODE #9's HotelCard-flags-prop fix, which this module
// reuses rather than needing its own render wiring).

// Same chain-keyword patterns as applyQualityLayer §2e (src/App.jsx),
// duplicated rather than imported because §2e's copy lives inline in a
// large component function, not an importable module — see that file's
// own comment on this constant for why each pattern is shaped as it is.
const LOYALTY_CHAIN_PATTERNS = {
  marriott: /\bmarriott\b|\bbonvoy\b/i,
  hilton: /\bhilton\b/i,
  hyatt: /\bhyatt\b/i,
  ihg: /\bihg\b|\bintercontinental\b/i,
  accor: /\baccor\b|\ball\s*-\s*accor live limitless/i,
  wyndham: /\bwyndham\b/i,
  choice: /\bchoice hotels\b|\bchoice privileges\b/i,
  bestwestern: /\bbest western\b/i,
};

const CHAIN_LABELS = {
  marriott: "Marriott",
  hilton: "Hilton",
  hyatt: "Hyatt",
  ihg: "IHG",
  accor: "Accor",
  wyndham: "Wyndham",
  choice: "Choice Hotels",
  bestwestern: "Best Western",
};

// Walk the plan and return candidate hotel-brand claims to verify:
//   [{ dayIdx, itemIdx, day, hotelName, city, chainKey, chainLabel }]
//
// Deliberately EXCLUDES any hotel §2e already flags (2+ distinct chains
// named together) — that's a stronger, self-contained structural tell this
// module shouldn't duplicate or contradict. Only a SINGLE named chain is a
// candidate here, since that's the shape §2e cannot evaluate at all.
export function collectHotelBrandClaims(plan, cityHint) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const out = [];
  days.forEach((day, dayIdx) => {
    const items = Array.isArray(day?.items) ? day.items : [];
    const hint = typeof cityHint === "function" ? cityHint(day, dayIdx) : (cityHint || "");
    items.forEach((item, itemIdx) => {
      if (String(item?.type || "") !== "Hotel" || !item.hotel?.name) return;
      const haystack = `${item.text || ""} ${item.hotel.confirmation_note || ""}`;
      const chains = Object.keys(LOYALTY_CHAIN_PATTERNS).filter((k) => LOYALTY_CHAIN_PATTERNS[k].test(haystack));
      if (chains.length !== 1) return; // 0 = nothing to check; 2+ = §2e's job, not this module's
      const chainKey = chains[0];
      out.push({
        dayIdx,
        itemIdx,
        day: dayIdx + 1,
        hotelName: item.hotel.name,
        city: hint,
        chainKey,
        chainLabel: CHAIN_LABELS[chainKey] || chainKey,
      });
    });
  });
  return out;
}

// Apply the server's Tripadvisor verdicts to the plan. `results` is keyed
// `${dayIdx}:${itemIdx}` -> { matched, resolvedName, description, error }
// (same keying convention as applyDriveTimeFlags).
//
// Only flags when Tripadvisor confidently resolved the SAME property
// (matched:true — the server's own nameMatchScore >= 0.80 guard already
// enforces this) and neither its resolved name nor its description
// mentions the claimed chain anywhere. Any other outcome (no match, low
// confidence, missing key, network error) is silently skipped — fail
// safe, per this app's hard rule: an unavailable or inconclusive check
// means unverified, never a wrong accusation.
export function applyHotelBrandFlags(plan, claims, results) {
  if (!plan || !Array.isArray(plan.days) || !results || typeof results.get !== "function" || claims.length === 0) {
    return { data: plan, flags: [] };
  }
  const unconfirmed = [];
  for (const claim of claims) {
    const r = results.get(`${claim.dayIdx}:${claim.itemIdx}`);
    if (!r || r.error || !r.matched) continue;
    const evidenceText = `${r.resolvedName || ""} ${r.description || ""}`;
    if (LOYALTY_CHAIN_PATTERNS[claim.chainKey].test(evidenceText)) continue; // independently confirmed — nothing to flag
    unconfirmed.push(claim);
  }
  if (unconfirmed.length === 0) return { data: plan, flags: [] };

  const byDay = new Map();
  for (const c of unconfirmed) {
    if (!byDay.has(c.dayIdx)) byDay.set(c.dayIdx, []);
    byDay.get(c.dayIdx).push(c);
  }

  const days = plan.days.map((day, dayIdx) => {
    const dayClaims = byDay.get(dayIdx);
    if (!dayClaims) return day;
    return {
      ...day,
      items: day.items.map((item, itemIdx) => {
        const claim = dayClaims.find((c) => c.itemIdx === itemIdx);
        if (!claim) return item;
        const prior = Array.isArray(item.flags) ? item.flags : [];
        return {
          ...item,
          flags: [...prior, `No independent confirmation of ${claim.chainLabel} affiliation found for ${claim.hotelName} — verify directly with the property before relying on this claim.`],
        };
      }),
    };
  });

  const flags = unconfirmed.map((c) => ({
    code: "HOTEL_BRAND_UNCONFIRMED",
    severity: "warn",
    dayIdx: c.dayIdx,
    itemIdx: c.itemIdx,
    day: c.day,
    target: c.hotelName,
    message: `${c.hotelName} claims ${c.chainLabel} affiliation, but an independent Tripadvisor lookup found no trace of it — verify directly with the property.`,
  }));

  return { data: { ...plan, days }, flags };
}
