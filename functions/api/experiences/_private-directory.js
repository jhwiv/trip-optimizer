// Curated private-operator directory.
//
// This is the "off-the-beaten-path" layer Jeff asked for. None of these
// operators has a public real-time inventory API, but every one has a public
// catalogue we can deep-link into (often with an affiliate code) or an
// inquiry form / email we can route a request to.
//
// Operators here are first-class results in the aggregator — the AI ranker
// treats them the same as Viator/GYG/Tiqets, and the UI shows them with an
// "Operated by Context Travel" / "Private — request to book" badge.
//
// To add a new operator, append a row below. Fields:
//   id               Stable slug, used in the Experience id (private:contextc-lisbon)
//   operator         Display name of the company
//   destinations     Array of destination strings or { match, label } objects.
//                    "match" can be a city, country, or region — the aggregator
//                    uses fuzzyScore() so "Lisbon" matches "Lisbon, Portugal".
//   categories       Lowercase tag list — used by the ranker.
//   tier             low / mid / high / ultra (editorial)
//   bookingMode      "inquiry" → "Request to book" CTA opens mailto/web form
//                    "redirect" → user goes to operator site to book directly
//   url              Deep link to the operator's destination/tour page
//                    (with affiliate code embedded if available)
//   contactEmail     For inquiry-mode operators
//   contactPhone     Optional
//   summary          One-line teaser
//   highlights       Bullet list of what makes them special
//   thumbnail        Image URL
//
// Adding/updating operators is editorial work. Treat this file like a
// curated database — every row should be a partner Jeff would personally
// recommend to a high-value client.

export const PRIVATE_OPERATORS = [
  // ---------------------------------------------------------------------
  // CONTEXT TRAVEL — scholar-led private walking tours.
  // Affiliate: 10% commission via explore.contexttravel.com/affiliate-home
  // Strongest in: Europe + NYC cultural cities.
  // ---------------------------------------------------------------------
  {
    id: "context-lisbon",
    operator: "Context Travel",
    operatorUrl: "https://www.contexttravel.com",
    destinations: ["Lisbon", "Lisbon, Portugal", "Portugal"],
    categories: ["culture", "history", "food", "private", "walking-tour"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.contexttravel.com/cities/lisbon",
    summary: "PhD-led private walking tours of Lisbon — Alfama, Belém, Fado history with scholars who actually live in the city.",
    highlights: [
      "Private only, party-size based pricing",
      "Hosts are working academics, journalists, chefs",
      "Custom itineraries on request",
      "Skip-the-line at Jerónimos and Belém Tower",
    ],
  },
  {
    id: "context-rome",
    operator: "Context Travel",
    operatorUrl: "https://www.contexttravel.com",
    destinations: ["Rome", "Rome, Italy", "Italy"],
    categories: ["culture", "history", "art", "private", "walking-tour"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.contexttravel.com/cities/rome",
    summary: "Vatican, Forum, and Trastevere with PhD art historians — the antithesis of the 50-person bus tour.",
    highlights: [
      "Early-access Vatican before public hours",
      "Private Sistine Chapel viewings (limited)",
      "Custom day-of-the-week scheduling",
    ],
  },
  {
    id: "context-paris",
    operator: "Context Travel",
    operatorUrl: "https://www.contexttravel.com",
    destinations: ["Paris", "Paris, France", "France"],
    categories: ["culture", "art", "history", "food", "private"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.contexttravel.com/cities/paris",
    summary: "Louvre, Marais, and patisserie deep-dives with French art historians and chefs.",
    highlights: [
      "Private Louvre with curator-level access",
      "Patisserie tours led by working pastry chefs",
      "After-hours museum options",
    ],
  },
  {
    id: "context-florence",
    operator: "Context Travel",
    operatorUrl: "https://www.contexttravel.com",
    destinations: ["Florence", "Florence, Italy", "Tuscany"],
    categories: ["culture", "art", "renaissance", "private"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.contexttravel.com/cities/florence",
    summary: "Uffizi, Brunelleschi, and Renaissance Florence — scholar guides who teach at Italian universities.",
    highlights: [
      "Private Uffizi tours",
      "Vasari Corridor access (when available)",
      "Tuscany day trips with art historians",
    ],
  },

  // ---------------------------------------------------------------------
  // TOURSBYLOCALS — vetted independent local guides, fully customizable.
  // Direct B2B feed not yet integrated; we link to their destination pages
  // and let the user pick a guide. Affiliate program contact: their B2B desk.
  // ---------------------------------------------------------------------
  {
    id: "tbl-lisbon",
    operator: "ToursByLocals",
    operatorUrl: "https://www.toursbylocals.com",
    destinations: ["Lisbon", "Lisbon, Portugal"],
    categories: ["private", "custom", "guide", "driver"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.toursbylocals.com/Lisbon-Tours",
    summary: "Hand-picked private guides in Lisbon — choose your guide by language, expertise, and itinerary.",
    highlights: [
      "Fully customizable itinerary",
      "Driver-guides with private vehicles available",
      "Half-day, full-day, and multi-day options",
      "4.9★+ guides only",
    ],
  },
  {
    id: "tbl-rome",
    operator: "ToursByLocals",
    operatorUrl: "https://www.toursbylocals.com",
    destinations: ["Rome", "Rome, Italy"],
    categories: ["private", "custom", "guide", "driver"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.toursbylocals.com/Rome-Tours",
    summary: "Private guides for Rome with optional Mercedes E-Class transfers — Vatican, Tivoli, Castelli Romani.",
    highlights: [
      "Same guide for multi-day itineraries",
      "Multilingual options",
      "Day trips out to Tivoli, Orvieto, Pompeii",
    ],
  },

  // ---------------------------------------------------------------------
  // WITHLOCALS — private food + culture tours hosted by locals.
  // Strong in: European cities, Asia. ~80 destinations.
  // ---------------------------------------------------------------------
  {
    id: "withlocals-lisbon",
    operator: "Withlocals",
    operatorUrl: "https://www.withlocals.com",
    destinations: ["Lisbon", "Lisbon, Portugal"],
    categories: ["food", "private", "local", "drinks"],
    tier: "mid",
    bookingMode: "redirect",
    url: "https://www.withlocals.com/experiences/lisbon/",
    summary: "Lisbon food tours hosted by local home cooks and chefs — tasca crawls, sunset rooftop drinks.",
    highlights: [
      "Private only — never grouped with strangers",
      "Hosts cap groups at one party",
      "Tipping-included pricing",
    ],
  },
  {
    id: "withlocals-tokyo",
    operator: "Withlocals",
    operatorUrl: "https://www.withlocals.com",
    destinations: ["Tokyo", "Tokyo, Japan", "Japan"],
    categories: ["food", "private", "local", "culture"],
    tier: "mid",
    bookingMode: "redirect",
    url: "https://www.withlocals.com/experiences/tokyo/",
    summary: "Private Tokyo food tours — Shibuya izakaya crawls, Tsukiji breakfast, Yanaka old-Tokyo walks.",
    highlights: [
      "Local hosts who actually live in the neighborhood",
      "Allergy/dietary customization standard",
    ],
  },

  // ---------------------------------------------------------------------
  // ATLAS OBSCURA — literal off-the-beaten-path. Affiliate via Skimlinks/Impact.
  // ---------------------------------------------------------------------
  {
    id: "atlas-experiences-italy",
    operator: "Atlas Obscura",
    operatorUrl: "https://www.atlasobscura.com",
    destinations: ["Italy", "Rome", "Florence", "Venice", "Sicily"],
    categories: ["unusual", "private", "small-group", "history"],
    tier: "high",
    bookingMode: "redirect",
    url: "https://www.atlasobscura.com/experiences",
    summary: "Atlas Obscura's small-group experiences — places and stories most tour books skip entirely.",
    highlights: [
      "Capped at 12 travelers",
      "Behind-closed-doors access (private archives, family vineyards, monastery libraries)",
      "Editorially curated — no commodity bus tours",
    ],
  },

  // ---------------------------------------------------------------------
  // INQUIRY-MODE EXAMPLE — a hand-picked driver/guide who doesn't sell
  // online inventory. The UI shows "Request to book" and posts the inquiry
  // through /api/inbound (or a future form-handler) to the operator's email.
  // Add more of these as Jeff vets specific people in each destination.
  // ---------------------------------------------------------------------
  // {
  //   id: "private-driver-tuscany-marco",
  //   operator: "Marco — Private Driver, Tuscany",
  //   destinations: ["Florence", "Siena", "Tuscany"],
  //   categories: ["driver", "private", "wine", "custom"],
  //   tier: "ultra",
  //   bookingMode: "inquiry",
  //   contactEmail: "marco@example.com",
  //   contactPhone: "+39 ...",
  //   summary: "Mercedes V-Class with English-speaking driver — Chianti, Bolgheri, Brunello day trips.",
  //   highlights: [
  //     "Lunch reservations at winemaker-only properties",
  //     "Custom multi-day Tuscany loops",
  //   ],
  // },
];
