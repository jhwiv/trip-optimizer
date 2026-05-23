import { useState, useEffect, useRef } from "react";

const GOLD = "#C4A862";
const GOLD_LIGHT = "#F5EDD6";
const GOLD_DARK = "#A08845";

// Curated city list for autocomplete. Free-text entries are still allowed.
const CITIES = [
  { name: "Lisbon", country: "Portugal" },
  { name: "Porto", country: "Portugal" },
  { name: "Madrid", country: "Spain" },
  { name: "Barcelona", country: "Spain" },
  { name: "Seville", country: "Spain" },
  { name: "San Sebastián", country: "Spain" },
  { name: "Paris", country: "France" },
  { name: "Nice", country: "France" },
  { name: "Bordeaux", country: "France" },
  { name: "Provence", country: "France" },
  { name: "Rome", country: "Italy" },
  { name: "Florence", country: "Italy" },
  { name: "Venice", country: "Italy" },
  { name: "Milan", country: "Italy" },
  { name: "Amalfi Coast", country: "Italy" },
  { name: "Lake Como", country: "Italy" },
  { name: "Sicily", country: "Italy" },
  { name: "London", country: "United Kingdom" },
  { name: "Edinburgh", country: "United Kingdom" },
  { name: "Dublin", country: "Ireland" },
  { name: "Amsterdam", country: "Netherlands" },
  { name: "Brussels", country: "Belgium" },
  { name: "Bruges", country: "Belgium" },
  { name: "Copenhagen", country: "Denmark" },
  { name: "Stockholm", country: "Sweden" },
  { name: "Oslo", country: "Norway" },
  { name: "Helsinki", country: "Finland" },
  { name: "Reykjavik", country: "Iceland" },
  { name: "Berlin", country: "Germany" },
  { name: "Munich", country: "Germany" },
  { name: "Vienna", country: "Austria" },
  { name: "Salzburg", country: "Austria" },
  { name: "Zurich", country: "Switzerland" },
  { name: "Geneva", country: "Switzerland" },
  { name: "Lucerne", country: "Switzerland" },
  { name: "St. Moritz", country: "Switzerland" },
  { name: "Prague", country: "Czechia" },
  { name: "Budapest", country: "Hungary" },
  { name: "Krakow", country: "Poland" },
  { name: "Athens", country: "Greece" },
  { name: "Santorini", country: "Greece" },
  { name: "Mykonos", country: "Greece" },
  { name: "Crete", country: "Greece" },
  { name: "Istanbul", country: "Turkey" },
  { name: "Dubrovnik", country: "Croatia" },
  { name: "Split", country: "Croatia" },
  { name: "Hvar", country: "Croatia" },
  { name: "Tokyo", country: "Japan" },
  { name: "Kyoto", country: "Japan" },
  { name: "Osaka", country: "Japan" },
  { name: "Hakone", country: "Japan" },
  { name: "Seoul", country: "South Korea" },
  { name: "Hong Kong", country: "China" },
  { name: "Singapore", country: "Singapore" },
  { name: "Bangkok", country: "Thailand" },
  { name: "Chiang Mai", country: "Thailand" },
  { name: "Bali", country: "Indonesia" },
  { name: "Hanoi", country: "Vietnam" },
  { name: "Ho Chi Minh City", country: "Vietnam" },
  { name: "Dubai", country: "UAE" },
  { name: "Abu Dhabi", country: "UAE" },
  { name: "Marrakech", country: "Morocco" },
  { name: "Cape Town", country: "South Africa" },
  { name: "Nairobi", country: "Kenya" },
  { name: "Sydney", country: "Australia" },
  { name: "Melbourne", country: "Australia" },
  { name: "Auckland", country: "New Zealand" },
  { name: "Queenstown", country: "New Zealand" },
  { name: "New York", country: "USA" },
  { name: "Boston", country: "USA" },
  { name: "Washington DC", country: "USA" },
  { name: "Chicago", country: "USA" },
  { name: "Miami", country: "USA" },
  { name: "New Orleans", country: "USA" },
  { name: "Charleston", country: "USA" },
  { name: "Nashville", country: "USA" },
  { name: "Austin", country: "USA" },
  { name: "Santa Fe", country: "USA" },
  { name: "Aspen", country: "USA" },
  { name: "Jackson Hole", country: "USA" },
  { name: "San Francisco", country: "USA" },
  { name: "Los Angeles", country: "USA" },
  { name: "Napa Valley", country: "USA" },
  { name: "Seattle", country: "USA" },
  { name: "Hawaii — Maui", country: "USA" },
  { name: "Hawaii — Kauai", country: "USA" },
  { name: "Naples", country: "USA" },
  { name: "Vancouver", country: "Canada" },
  { name: "Toronto", country: "Canada" },
  { name: "Montreal", country: "Canada" },
  { name: "Quebec City", country: "Canada" },
  { name: "Mexico City", country: "Mexico" },
  { name: "Cabo San Lucas", country: "Mexico" },
  { name: "Tulum", country: "Mexico" },
  { name: "Buenos Aires", country: "Argentina" },
  { name: "Rio de Janeiro", country: "Brazil" },
  { name: "Lima", country: "Peru" },
  { name: "Cusco", country: "Peru" },
  { name: "Cartagena", country: "Colombia" },
];

// Airports — major US + key international hubs. Keyed by code; searchable by code, city, or name.
const AIRPORTS = [
  { code: "EWR", city: "Newark", name: "Newark Liberty Intl" },
  { code: "JFK", city: "New York", name: "John F. Kennedy Intl" },
  { code: "LGA", city: "New York", name: "LaGuardia" },
  { code: "BOS", city: "Boston", name: "Logan Intl" },
  { code: "PHL", city: "Philadelphia", name: "Philadelphia Intl" },
  { code: "BWI", city: "Baltimore", name: "Baltimore/Washington" },
  { code: "DCA", city: "Washington DC", name: "Reagan National" },
  { code: "IAD", city: "Washington DC", name: "Dulles Intl" },
  { code: "ATL", city: "Atlanta", name: "Hartsfield-Jackson" },
  { code: "MIA", city: "Miami", name: "Miami Intl" },
  { code: "FLL", city: "Fort Lauderdale", name: "Hollywood Intl" },
  { code: "MCO", city: "Orlando", name: "Orlando Intl" },
  { code: "TPA", city: "Tampa", name: "Tampa Intl" },
  { code: "RSW", city: "Fort Myers", name: "Southwest Florida" },
  { code: "CLT", city: "Charlotte", name: "Douglas Intl" },
  { code: "RDU", city: "Raleigh-Durham", name: "Raleigh-Durham Intl" },
  { code: "CHS", city: "Charleston", name: "Charleston Intl" },
  { code: "SAV", city: "Savannah", name: "Savannah/Hilton Head" },
  { code: "BNA", city: "Nashville", name: "Nashville Intl" },
  { code: "MSY", city: "New Orleans", name: "Louis Armstrong" },
  { code: "AUS", city: "Austin", name: "Bergstrom Intl" },
  { code: "DFW", city: "Dallas", name: "Dallas/Fort Worth" },
  { code: "IAH", city: "Houston", name: "Bush Intercontinental" },
  { code: "ORD", city: "Chicago", name: "O’Hare Intl" },
  { code: "MDW", city: "Chicago", name: "Midway Intl" },
  { code: "DTW", city: "Detroit", name: "Metro Wayne County" },
  { code: "MSP", city: "Minneapolis", name: "Minneapolis-St. Paul" },
  { code: "DEN", city: "Denver", name: "Denver Intl" },
  { code: "PHX", city: "Phoenix", name: "Sky Harbor" },
  { code: "LAS", city: "Las Vegas", name: "Harry Reid Intl" },
  { code: "SLC", city: "Salt Lake City", name: "Salt Lake City Intl" },
  { code: "LAX", city: "Los Angeles", name: "Los Angeles Intl" },
  { code: "SAN", city: "San Diego", name: "San Diego Intl" },
  { code: "SFO", city: "San Francisco", name: "San Francisco Intl" },
  { code: "OAK", city: "Oakland", name: "Oakland Intl" },
  { code: "SJC", city: "San Jose", name: "Norman Y. Mineta" },
  { code: "SEA", city: "Seattle", name: "Seattle-Tacoma" },
  { code: "PDX", city: "Portland", name: "Portland Intl" },
  { code: "HNL", city: "Honolulu", name: "Daniel K. Inouye" },
  { code: "OGG", city: "Maui", name: "Kahului" },
  { code: "LIH", city: "Kauai", name: "Lihue" },
  { code: "ABQ", city: "Albuquerque", name: "Albuquerque Intl Sunport" },
  { code: "SAF", city: "Santa Fe", name: "Santa Fe Regional" },
  { code: "ASE", city: "Aspen", name: "Pitkin County" },
  { code: "JAC", city: "Jackson Hole", name: "Jackson Hole Airport" },
  { code: "YYZ", city: "Toronto", name: "Pearson Intl" },
  { code: "YUL", city: "Montreal", name: "Pierre Elliott Trudeau" },
  { code: "YVR", city: "Vancouver", name: "Vancouver Intl" },
  { code: "LHR", city: "London", name: "Heathrow" },
  { code: "LGW", city: "London", name: "Gatwick" },
  { code: "CDG", city: "Paris", name: "Charles de Gaulle" },
  { code: "ORY", city: "Paris", name: "Orly" },
  { code: "AMS", city: "Amsterdam", name: "Schiphol" },
  { code: "FRA", city: "Frankfurt", name: "Frankfurt am Main" },
  { code: "MUC", city: "Munich", name: "Franz Josef Strauss" },
  { code: "ZRH", city: "Zurich", name: "Zürich Airport" },
  { code: "GVA", city: "Geneva", name: "Cointrin" },
  { code: "FCO", city: "Rome", name: "Fiumicino" },
  { code: "MXP", city: "Milan", name: "Malpensa" },
  { code: "VCE", city: "Venice", name: "Marco Polo" },
  { code: "BCN", city: "Barcelona", name: "El Prat" },
  { code: "MAD", city: "Madrid", name: "Barajas" },
  { code: "LIS", city: "Lisbon", name: "Humberto Delgado" },
  { code: "OPO", city: "Porto", name: "Francisco Sá Carneiro" },
  { code: "CPH", city: "Copenhagen", name: "Kastrup" },
  { code: "ARN", city: "Stockholm", name: "Arlanda" },
  { code: "DUB", city: "Dublin", name: "Dublin Airport" },
  { code: "EDI", city: "Edinburgh", name: "Edinburgh Airport" },
  { code: "KEF", city: "Reykjavik", name: "Keflavík Intl" },
  { code: "IST", city: "Istanbul", name: "Istanbul Airport" },
  { code: "ATH", city: "Athens", name: "Eleftherios Venizelos" },
  { code: "DBV", city: "Dubrovnik", name: "Dubrovnik Airport" },
  { code: "NRT", city: "Tokyo", name: "Narita Intl" },
  { code: "HND", city: "Tokyo", name: "Haneda" },
  { code: "KIX", city: "Osaka", name: "Kansai Intl" },
  { code: "ICN", city: "Seoul", name: "Incheon Intl" },
  { code: "HKG", city: "Hong Kong", name: "Hong Kong Intl" },
  { code: "SIN", city: "Singapore", name: "Changi" },
  { code: "BKK", city: "Bangkok", name: "Suvarnabhumi" },
  { code: "DXB", city: "Dubai", name: "Dubai Intl" },
  { code: "AUH", city: "Abu Dhabi", name: "Zayed Intl" },
  { code: "DOH", city: "Doha", name: "Hamad Intl" },
  { code: "SYD", city: "Sydney", name: "Kingsford Smith" },
  { code: "MEL", city: "Melbourne", name: "Tullamarine" },
  { code: "AKL", city: "Auckland", name: "Auckland Airport" },
  { code: "CPT", city: "Cape Town", name: "Cape Town Intl" },
  { code: "GRU", city: "São Paulo", name: "Guarulhos" },
  { code: "EZE", city: "Buenos Aires", name: "Ministro Pistarini" },
  { code: "MEX", city: "Mexico City", name: "Benito Juárez" },
  { code: "SJD", city: "Cabo San Lucas", name: "Los Cabos Intl" },
  { code: "CUN", city: "Cancun", name: "Cancún Intl" },
];

// Airlines — major carriers globally.
const AIRLINES = [
  "United", "American", "Delta", "JetBlue", "Alaska", "Southwest", "Spirit", "Frontier", "Hawaiian",
  "Air Canada", "WestJet",
  "British Airways", "Virgin Atlantic", "Lufthansa", "Swiss", "Austrian", "Brussels Airlines",
  "Air France", "KLM", "Iberia", "TAP Air Portugal", "Aer Lingus",
  "ITA Airways", "Alitalia", "Finnair", "SAS", "Icelandair", "Norwegian",
  "Turkish Airlines", "Emirates", "Etihad", "Qatar Airways", "Saudia",
  "Japan Airlines", "ANA", "Korean Air", "Asiana", "Cathay Pacific", "Singapore Airlines",
  "Thai Airways", "EVA Air", "China Airlines",
  "Qantas", "Air New Zealand", "Fiji Airways",
  "LATAM", "Aeroméxico", "Avianca", "Copa",
  "Ethiopian", "South African Airways", "Kenya Airways",
];

// Rental-car companies with regional coverage. Most majors operate at virtually all
// commercial airports in their listed regions — so we filter the suggestion list by
// the *region* of the chosen home airport, and label brands that are airport-specialist
// vs. only available downtown.
// regions: us, eu, uk, asia, oceania, mideast, latam, africa, global
const RENTAL_COMPANIES = [
  { name: "Hertz", regions: ["global"], airportDesks: true, note: "Gold Plus Rewards" },
  { name: "Hertz Dream Cars", regions: ["us", "eu"], airportDesks: true, note: "Exotic / luxury — select airports" },
  { name: "Enterprise", regions: ["us", "uk", "eu", "latam"], airportDesks: true },
  { name: "National", regions: ["us", "uk", "eu", "latam"], airportDesks: true, note: "Emerald Club" },
  { name: "Alamo", regions: ["us", "eu", "latam"], airportDesks: true },
  { name: "Avis", regions: ["global"], airportDesks: true, note: "Preferred" },
  { name: "Budget", regions: ["global"], airportDesks: true },
  { name: "Sixt", regions: ["global"], airportDesks: true, note: "Strong in Europe" },
  { name: "Sixt Black", regions: ["eu", "us", "mideast"], airportDesks: true, note: "Premium tier" },
  { name: "Europcar", regions: ["eu", "uk", "africa", "asia", "oceania"], airportDesks: true },
  { name: "Thrifty", regions: ["global"], airportDesks: true },
  { name: "Dollar", regions: ["global"], airportDesks: true },
  { name: "Silvercar by Audi", regions: ["us"], airportDesks: true, note: "Audi only, select US airports" },
  { name: "Auto Europe", regions: ["eu", "uk"], airportDesks: true, note: "Aggregator — best European rates" },
  { name: "Kemwel", regions: ["eu"], airportDesks: true, note: "European specialist" },
  { name: "Turo", regions: ["us", "uk", "eu"], airportDesks: false, note: "Peer-to-peer — some airport delivery" },
  { name: "Times Car Rental", regions: ["asia"], airportDesks: true, note: "Japan" },
  { name: "Nippon Rent-A-Car", regions: ["asia"], airportDesks: true, note: "Japan" },
  { name: "Lotte Rent-a-Car", regions: ["asia"], airportDesks: true, note: "Korea" },
];

// Map of airport IATA code → region key, used to filter rental-company suggestions.
const AIRPORT_REGIONS = {
  // US
  EWR:"us", JFK:"us", LGA:"us", BOS:"us", PHL:"us", BWI:"us", DCA:"us", IAD:"us", ATL:"us",
  MIA:"us", FLL:"us", MCO:"us", TPA:"us", RSW:"us", CLT:"us", RDU:"us", CHS:"us", SAV:"us",
  BNA:"us", MSY:"us", AUS:"us", DFW:"us", IAH:"us", ORD:"us", MDW:"us", DTW:"us", MSP:"us",
  DEN:"us", PHX:"us", LAS:"us", SLC:"us", LAX:"us", SAN:"us", SFO:"us", OAK:"us", SJC:"us",
  SEA:"us", PDX:"us", HNL:"us", OGG:"us", LIH:"us", ABQ:"us", SAF:"us", ASE:"us", JAC:"us",
  // Canada
  YYZ:"us", YUL:"us", YVR:"us",
  // UK / Europe
  LHR:"uk", LGW:"uk",
  CDG:"eu", ORY:"eu", AMS:"eu", FRA:"eu", MUC:"eu", ZRH:"eu", GVA:"eu", FCO:"eu", MXP:"eu",
  VCE:"eu", BCN:"eu", MAD:"eu", LIS:"eu", OPO:"eu", CPH:"eu", ARN:"eu", DUB:"eu", EDI:"uk",
  KEF:"eu", IST:"eu", ATH:"eu", DBV:"eu",
  // Asia
  NRT:"asia", HND:"asia", KIX:"asia", ICN:"asia", HKG:"asia", SIN:"asia", BKK:"asia",
  // Middle East
  DXB:"mideast", AUH:"mideast", DOH:"mideast",
  // Oceania / Africa / LatAm
  SYD:"oceania", MEL:"oceania", AKL:"oceania",
  CPT:"africa",
  GRU:"latam", EZE:"latam", MEX:"latam", SJD:"latam", CUN:"latam",
};

function getAirportRegion(airportInput) {
  if (!airportInput) return null;
  // Accept full code or first 3 chars of input.
  const code = airportInput.trim().toUpperCase().slice(0, 3);
  return AIRPORT_REGIONS[code] || null;
}

function getRentalCompanies(airportInput) {
  const region = getAirportRegion(airportInput);
  if (!region) return RENTAL_COMPANIES; // unknown — show all
  return RENTAL_COMPANIES.filter(c =>
    c.regions.includes("global") || c.regions.includes(region)
  );
}

// Vehicle types for rental car / ground transport.
const VEHICLE_TYPES = [
  "Sedan", "Compact", "Midsize SUV", "Full-size SUV", "Luxury SUV",
  "Luxury sedan", "Convertible", "Sports car", "Minivan", "Pickup truck",
  "EV — Tesla Model 3", "EV — Tesla Model Y", "EV — Tesla Model S",
  "Wagon / estate", "7-seater", "4WD / off-road",
];

// Universal restaurant / dining types.
const RESTAURANT_TYPES_BASE = [
  "Michelin-starred", "Fine dining", "Wine bar", "Tasting menu",
  "Local seafood", "Steakhouse", "Sushi / omakase", "Italian — trattoria",
  "Italian — osteria", "French bistro", "Brasserie", "Tapas / pintxos",
  "Farm-to-table", "Waterfront dining", "Rooftop bar", "Speakeasy",
  "Hotel bar", "Cafe / breakfast", "Brunch spot", "Bakery / pastries",
  "Market hall", "Street food", "Beer garden", "Casual lunch",
];

// Destination-specific restaurant suggestions (matched by substring of destination string).
const RESTAURANT_BY_DEST = {
  lisbon:    ["Petiscos / tasca", "Pastel de nata stop", "Seafood marisqueira", "Fado dinner", "Port wine bar"],
  porto:     ["Francesinha lunch", "Port wine cellar tasting", "Riverside seafood", "Tasca / petiscos"],
  paris:     ["Classic brasserie", "Bistrot de quartier", "Boulangerie breakfast", "Wine bar / cave à manger", "Café terrace", "Steak frites"],
  rome:      ["Trastevere trattoria", "Roman carbonara / cacio e pepe", "Aperitivo bar", "Gelateria", "Wood-fired pizza al taglio"],
  florence:  ["Bistecca alla Fiorentina", "Enoteca", "Tuscan trattoria", "Aperitivo at sunset", "Gelateria"],
  venice:    ["Cicchetti bacaro crawl", "Seafood risotto", "Spritz on the canal", "Osteria for fresh pasta"],
  milan:     ["Aperitivo Navigli", "Risotto alla Milanese", "Brera enoteca", "Panzerotti lunch"],
  barcelona: ["Tapas crawl", "Pintxos bar", "Catalan seafood", "Vermut hour", "Boqueria market lunch"],
  madrid:    ["Tapas crawl La Latina", "Cocido madrile\u00f1o", "Jam\u00f3n ib\u00e9rico bar", "Mercado de San Miguel"],
  london:    ["Sunday roast", "Indian curry house", "Gastropub", "Afternoon tea", "Pie & mash", "Cocktail bar"],
  edinburgh: ["Scottish seafood", "Whisky bar", "Gastropub", "Modern Scottish tasting menu"],
  amsterdam: ["Brown caf\u00e9", "Rijsttafel (Indonesian)", "Canal-side bistro", "Bitterballen bar"],
  copenhagen:["New Nordic tasting menu", "Smushi / sm\u00f8rrebr\u00f8d lunch", "Natural wine bar", "Bakery (Hart, Juno)"],
  zurich:    ["Z\u00fcrcher Geschnetzeltes", "Swiss fondue / raclette", "Lake-view bistro", "Caf\u00e9 / Confiserie"],
  tokyo:     ["Sushi omakase", "Tempura counter", "Tonkatsu specialist", "Ramen shop", "Izakaya", "Kaiseki dinner", "Yakitori alley"],
  kyoto:     ["Kaiseki ryokan dinner", "Tofu specialist", "Kyo-kaiseki lunch", "Matcha tea house", "Pontoch\u014d alley dining"],
  osaka:     ["Okonomiyaki", "Takoyaki stand", "Kushikatsu bar", "Dotonbori street food"],
  "new york": ["Steakhouse classic", "Pizza slice joint", "Bagel + lox breakfast", "Omakase counter", "Speakeasy cocktail bar", "Italian red sauce"],
  "new orleans": ["Creole classic", "Po-boy lunch", "Beignets at Caf\u00e9 du Monde", "Jazz brunch", "Cajun seafood boil"],
  miami:     ["Cuban sandwich lunch", "Stone crab", "Cuban steakhouse", "Wynwood food hall", "Cafecito stop"],
  charleston:["Lowcountry seafood", "She-crab soup", "Southern fine dining", "Shrimp & grits brunch"],
  napa:      ["Winery tasting room lunch", "Michelin tasting menu", "Farm-to-table bistro"],
  "santa fe":["New Mexican \u2014 red & green chile", "Modern Southwestern", "Margarita & rooftop", "Posole / sopaipillas"],
  naples:    ["Old Naples bistro", "Gulf seafood", "Fifth Avenue South dining", "Beach club lunch"],
  dubrovnik: ["Konoba (tavern)", "Adriatic seafood", "Peka (under the bell)", "Sea-view fine dining"],
  split:     ["Riva caf\u00e9 stop", "Dalmatian seafood", "Konoba dinner", "Marjan hill bistro"],
  sydney:    ["Modern Australian tasting menu", "Harbour-view dining", "Coffee culture caf\u00e9", "Bondi brunch"],
  "cape town":["Cape Malay cuisine", "Wine farm lunch", "Braai (BBQ)", "Camps Bay sunset dining"],
};

function getRestaurantSuggestions(destination) {
  const d = (destination || "").toLowerCase();
  const extra = [];
  for (const [k, list] of Object.entries(RESTAURANT_BY_DEST)) {
    if (d.includes(k)) { extra.push(...list); break; }
  }
  return [...extra, ...RESTAURANT_TYPES_BASE];
}

// Universal activities.
const ACTIVITY_TYPES_BASE = [
  "Private city walking tour", "Food tour", "Wine tasting", "Cooking class",
  "Museum — skip-the-line", "Art gallery visit", "Architecture tour",
  "Sunset boat cruise", "Private driver day trip", "Day trip to nearby town",
  "Golf — 18 holes", "Spa day", "Hot springs / thermal bath",
  "Hiking — half day", "Bike tour", "E-bike rental",
  "Live music / jazz club", "Theater / opera", "Local market visit",
  "Photography walk", "Beach day", "Snorkeling", "Helicopter tour",
  "Hot air balloon", "Horseback riding", "Ski / snowboard day",
];

// Destination-specific iconic activities.
const ACTIVITY_BY_DEST = {
  lisbon:   ["Tram 28 ride", "Day trip to Sintra", "Belem & Jer\u00f3nimos Monastery", "Time Out Market", "LX Factory afternoon"],
  porto:    ["Douro Valley wine day", "Port wine cellar tour", "Livraria Lello visit", "S\u00e3o Bento azulejos"],
  paris:    ["Louvre \u2014 timed entry", "Mus\u00e9e d'Orsay", "Versailles day trip", "Seine evening cruise", "Montmartre walk", "Wine cellar tasting"],
  rome:     ["Vatican Museums + Sistine", "Colosseum underground tour", "Trastevere food walk", "Borghese Gallery (book ahead)", "Aperitivo at sunset"],
  florence: ["Uffizi reserved entry", "Accademia \u2014 see David", "Chianti wine day", "Boboli Gardens", "Duomo dome climb"],
  venice:   ["Doge's Palace early", "Gondola at sunset", "Murano + Burano boat", "Cicchetti crawl"],
  barcelona:["Sagrada Fam\u00edlia timed entry", "Park G\u00fcell", "Tapas walking tour", "Picasso Museum"],
  madrid:   ["Prado timed entry", "Royal Palace + Almudena", "Toledo day trip", "Flamenco show"],
  london:   ["Westminster + Churchill War Rooms", "British Museum highlights", "West End show", "Borough Market", "Afternoon tea"],
  edinburgh:["Edinburgh Castle", "Royal Mile walk", "Whisky tasting", "Arthur's Seat hike"],
  amsterdam:["Rijksmuseum", "Van Gogh Museum (book)", "Anne Frank House (book early)", "Canal cruise"],
  copenhagen:["Tivoli Gardens evening", "Nyhavn stroll", "Louisiana Museum day trip", "Bike the city"],
  zurich:   ["Lake Zurich boat", "Uetliberg sunset", "Day trip to Lucerne / Rigi", "Lindt Home of Chocolate"],
  tokyo:    ["teamLab digital art", "Tsukiji outer market breakfast", "Meiji Shrine + Harajuku", "Shibuya crossing + Hachiko", "Day trip to Hakone"],
  kyoto:    ["Fushimi Inari sunrise", "Arashiyama bamboo + monkeys", "Kinkaku-ji + Ryoan-ji", "Gion geisha walk", "Tea ceremony"],
  osaka:    ["Osaka Castle", "Dotonbori night walk", "Day trip to Nara (deer + Todai-ji)"],
  "new york": ["Broadway show", "Top of the Rock at sunset", "MoMA + Frick", "High Line walk", "Yankee / Mets game"],
  "new orleans": ["Frenchmen Street jazz", "Garden District walk", "Steamboat Natchez", "Cooking class"],
  miami:     ["South Beach Art Deco walk", "Vizcaya Museum", "Wynwood walls", "Everglades airboat"],
  napa:      ["3-winery tasting day", "Hot air balloon at dawn", "Castello di Amorosa", "Calistoga mud bath"],
  "santa fe":["Canyon Road galleries", "Georgia O'Keeffe Museum", "Bandelier ruins day trip", "Ten Thousand Waves spa"],
  naples:    ["Naples Pier sunset", "Marco Island day", "Naples Botanical Garden", "Tin City", "Beach club day"],
  aspen:     ["Maroon Bells", "Ski / snowboard", "Snowmass gondola", "Apr\u00e8s-ski at Aj\u0061x Tavern"],
  dubrovnik: ["Walk the City Walls early", "Lokrum island ferry", "Game of Thrones tour", "Kayak around Old Town"],
  sydney:    ["Sydney Harbour Bridge climb", "Opera House tour + show", "Bondi-to-Coogee walk", "Manly ferry day"],
  "cape town": ["Table Mountain cable car", "Cape Point / Boulders penguins", "Stellenbosch wine day", "Robben Island"],
};

function getActivitySuggestions(destination) {
  const d = (destination || "").toLowerCase();
  const extra = [];
  for (const [k, list] of Object.entries(ACTIVITY_BY_DEST)) {
    if (d.includes(k)) { extra.push(...list); break; }
  }
  return [...extra, ...ACTIVITY_TYPES_BASE];
}

// Cuisine preferences suggestions (single-field, comma-friendly).
const CUISINE_SUGGESTIONS = [
  "Local / traditional", "Seafood-focused", "Wine-focused",
  "Vegetarian-friendly", "Pescatarian", "Gluten-free options",
  "Adventurous / chef's choice", "Family-style sharing", "Romantic dinners",
  "Light lunches, big dinners", "Bakeries & caf\u00e9s", "Street food",
  "Michelin-focused", "Mixed — casual + a few splurges",
];

// Hotel must-have suggestions.
const HOTEL_MUSTHAVE_SUGGESTIONS = [
  "Walkable to dining", "Pool / rooftop pool", "Spa on-site",
  "Lounge access / club level", "Suite upgrade preferred", "Connecting rooms",
  "Late check-out", "Kitchenette / full kitchen", "Quiet floor",
  "Sea view", "City view", "Old Town location", "Fitness center",
  "Free breakfast", "24-hour room service", "Family-friendly",
  "Pet-friendly", "Concierge desk", "Valet parking",
];

// Travelers / party-composition presets.
const TRAVELER_PRESETS = [
  "1 adult", "2 adults", "2 adults + 1 child", "2 adults + 2 children",
  "Family of 4", "Family of 5", "3 adults", "4 adults",
  "Couple's getaway", "Solo trip", "Group of friends",
];

// Interests free-text suggestions.
const INTEREST_SUGGESTIONS = [
  "Art & architecture", "Wine & food", "History & ruins", "Modern art / galleries",
  "Golf", "Beach & relaxation", "Hiking & nature", "Shopping",
  "Photography", "Music & nightlife", "Family-friendly activities", "Spa & wellness",
  "Adventure / outdoor sports", "Off-the-beaten-path",
];

// Hotel brands / sub-brands across major loyalty families.
const HOTEL_TIERS = [
  // Marriott family
  "Ritz-Carlton", "Ritz-Carlton Reserve", "St. Regis", "JW Marriott", "Edition", "Bvlgari Hotels",
  "W Hotels", "Luxury Collection", "Marriott", "Sheraton", "Westin", "Le Méridien",
  "Autograph Collection", "Tribute Portfolio", "Renaissance", "Marriott Bonvoy",
  "Courtyard", "Residence Inn", "Aloft", "Moxy",
  // Hilton family
  "Waldorf Astoria", "Conrad", "LXR", "Canopy", "Hilton", "DoubleTree", "Embassy Suites",
  "Curio Collection", "Tapestry Collection", "Hampton Inn",
  // Hyatt family
  "Park Hyatt", "Andaz", "Grand Hyatt", "Hyatt Regency", "Hyatt Centric", "Alila", "Thompson",
  "Miraval", "Hyatt House",
  // IHG family
  "Six Senses", "Regent", "InterContinental", "Vignette Collection", "Kimpton", "Hotel Indigo",
  "Crowne Plaza", "voco",
  // Independent / boutique
  "Aman", "Belmond", "Four Seasons", "Mandarin Oriental", "Peninsula", "Rosewood",
  "Soho House", "Auberge Resorts", "Oetker Collection", "Cheval Blanc", "Capella",
];

function formatDateForDisplay(iso) {
  if (!iso) return "";
  // iso like "2027-06-03" — keep it locale-independent
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m,10)-1]} ${parseInt(d,10)}, ${y}`;
}

const areaHints = {
  default: "e.g. Old Town, waterfront, city center, suburbs, hillside",
  lisbon: "e.g. Baixa / Chiado, Alfama, Bairro Alto, Belém, Príncipe Real",
  porto: "e.g. Ribeira, Cedofeita, Foz do Douro, Boavista",
  paris: "e.g. Le Marais, Saint-Germain, Montmartre, 7th arrondissement",
  rome: "e.g. Centro Storico, Trastevere, Prati, Testaccio",
  florence: "e.g. Duomo district, Oltrarno, Santa Croce, San Niccolò",
  barcelona: "e.g. Gothic Quarter, Eixample, Gràcia, Barceloneta",
  madrid: "e.g. Centro / Sol, Malasaña, Salamanca, La Latina",
  london: "e.g. Mayfair, Chelsea, South Bank, Notting Hill, Shoreditch",
  edinburgh: "e.g. Old Town, New Town, Leith, Stockbridge",
  amsterdam: "e.g. Canal Ring, Jordaan, De Pijp, Museum Quarter",
  tokyo: "e.g. Shinjuku, Ginza, Shibuya, Asakusa, Roppongi",
  kyoto: "e.g. Gion, Higashiyama, Arashiyama, Kawaramachi",
  osaka: "e.g. Namba, Shinsaibashi, Umeda, Shinsekai",
  "new york": "e.g. Midtown, Upper East Side, Tribeca, Brooklyn Heights",
  "new orleans": "e.g. French Quarter, Garden District, Marigny, Uptown",
  chicago: "e.g. Magnificent Mile, Gold Coast, Lincoln Park, River North",
  miami: "e.g. South Beach, Brickell, Wynwood, Coconut Grove",
  "santa fe": "e.g. Downtown / Plaza, Canyon Road, Railyard, East Side",
  naples: "e.g. Old Naples, Vanderbilt Beach, Port Royal, Pelican Bay",
  dubrovnik: "e.g. Old Town, Lapad Peninsula, Babin Kuk, Pile Gate area",
  split: "e.g. Diocletian's Palace, Meje, Spinut, Žnjan",
  zurich: "e.g. Altstadt, Zürichberg, Enge, Seefeld",
  copenhagen: "e.g. Indre By, Frederiksberg, Nørrebro, Christianshavn",
  sydney: "e.g. CBD / The Rocks, Bondi, Paddington, Surry Hills",
  "cape town": "e.g. V&A Waterfront, Atlantic Seaboard, Gardens, Sea Point",
};

function getAreaHint(dest) {
  if (!dest.trim()) return areaHints.default;
  const d = dest.toLowerCase();
  for (const [k, v] of Object.entries(areaHints)) {
    if (d.includes(k)) return v;
  }
  return areaHints.default;
}

const BADGE_COLORS = {
  Flight: { bg: "#EBF4FF", color: "#1E5FA8" },
  Hotel: { bg: "#EDFAF3", color: "#1A6B42" },
  Car: { bg: "#E8FAF5", color: "#0F6B56" },
  Dinner: { bg: "#FEF3E2", color: "#92500A" },
  Lunch: { bg: "#FEF3E2", color: "#92500A" },
  Breakfast: { bg: "#FEF3E2", color: "#92500A" },
  Activity: { bg: "#F0EEFF", color: "#4A35B0" },
  Flag: { bg: "#FEF0EF", color: "#B03535" },
  "Plan B": { bg: "#F5F5F5", color: "#555" },
  Snob: { bg: "#FEF0F8", color: "#8B2566" },
  Tonight: { bg: "#FEF8E2", color: "#7A5C00" },
  Note: { bg: "#F0F4FF", color: "#334CA0" },
};

function Badge({ type }) {
  const c = BADGE_COLORS[type] || { bg: "#F0F0F0", color: "#555" };
  return (
    <span style={{
      display: "inline-block", fontSize: "10px", fontWeight: "600",
      padding: "2px 8px", borderRadius: "3px", whiteSpace: "nowrap",
      background: c.bg, color: c.color, letterSpacing: "0.04em",
    }}>{type}</span>
  );
}

function DayBlock({ day, onOpenMenu }) {
  return (
    <div style={{ borderLeft: `2px solid ${GOLD}`, paddingLeft: "1rem", marginBottom: "1.5rem", borderRadius: 0 }}>
      <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-text-primary)", margin: "0 0 10px", letterSpacing: "0.02em" }}>{day.label}</p>
      {day.items.map((item, i) => {
        // Dining items with a structured restaurant payload render as a rich card.
        if (item.restaurant && (item.type === "Dinner" || item.type === "Lunch" || item.type === "Breakfast" || item.type === "Brunch" || item.type === "Dining")) {
          return <RestaurantCard key={i} type={item.type} restaurant={item.restaurant} onOpenMenu={onOpenMenu} />;
        }
        return (
          <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "7px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: "1.5" }}>
            <Badge type={item.type} />
            <span style={{ color: "var(--color-text-secondary)" }}>{item.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// Build a reservation URL from a restaurant payload.
// Anthropic should provide reservation.url directly; this is a fallback that
// constructs a search URL on the named platform.
function reservationLink(r) {
  if (!r || !r.reservation) return null;
  const platform = (r.reservation.platform || "").toLowerCase();
  if (r.reservation.url) return { platform, url: r.reservation.url };
  const q = encodeURIComponent(r.name || "");
  if (platform === "opentable") return { platform, url: `https://www.opentable.com/s?term=${q}` };
  if (platform === "resy") return { platform, url: `https://resy.com/cities/search?query=${q}` };
  if (platform === "tock") return { platform, url: `https://www.exploretock.com/search?query=${q}` };
  if (platform === "yelp") return { platform, url: `https://www.yelp.com/search?find_desc=${q}` };
  if (platform === "phone" && r.reservation.phone) return { platform, url: `tel:${r.reservation.phone}` };
  return null;
}

function RestaurantCard({ type, restaurant: r, onOpenMenu }) {
  const resv = reservationLink(r);
  const platformLabel = resv ? ({
    opentable: "OpenTable", resy: "Resy", tock: "Tock", yelp: "Yelp", phone: "Call",
  }[resv.platform] || "Reserve") : null;

  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
        <Badge type={type} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1 }}>{r.name}</p>
      </div>
      {(r.neighborhood || r.cuisine || r.price_range) && (
        <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 6px", letterSpacing: "0.02em" }}>
          {[r.neighborhood, r.cuisine, r.price_range].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {r.why && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>{r.why}</p>}
      {r.closure_note && (
        <p style={{ fontSize: "11px", color: r.closure_note.toLowerCase().includes("confirm") ? "#B85C00" : "var(--color-text-tertiary)", margin: "0 0 8px", fontStyle: "italic" }}>
          ⚠︎ {r.closure_note}
        </p>
      )}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "6px" }}>
        {r.menu && (
          <button
            onClick={() => onOpenMenu(r)}
            style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: `0.5px solid ${GOLD}`, background: "transparent", color: GOLD, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500 }}
          >View Menu</button>
        )}
        {resv && (
          <a
            href={resv.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "11px", padding: "7px 12px", borderRadius: "4px", border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, textDecoration: "none", display: "inline-block" }}
          >Reserve · {platformLabel}</a>
        )}
      </div>
      {r.backup && (
        <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
          <p style={{ fontSize: "10px", color: "var(--color-text-tertiary)", margin: "0 0 4px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>Backup if no table</p>
          <p style={{ fontSize: "12.5px", color: "var(--color-text-primary)", margin: "0 0 4px", fontWeight: 500 }}>{r.backup.name}</p>
          {(r.backup.neighborhood || r.backup.cuisine) && (
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 6px" }}>{[r.backup.neighborhood, r.backup.cuisine].filter(Boolean).join("  ·  ")}</p>
          )}
          {r.backup.why && <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "0 0 6px", lineHeight: 1.5 }}>{r.backup.why}</p>}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {r.backup.menu && (
              <button
                onClick={() => onOpenMenu(r.backup)}
                style={{ fontSize: "10.5px", padding: "5px 10px", borderRadius: "4px", border: `0.5px solid var(--color-border-secondary)`, background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", textTransform: "uppercase" }}
              >Menu</button>
            )}
            {reservationLink(r.backup) && (
              <a
                href={reservationLink(r.backup).url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "10.5px", padding: "5px 10px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em", textTransform: "uppercase", textDecoration: "none" }}
              >Reserve · {({opentable:"OpenTable",resy:"Resy",tock:"Tock",yelp:"Yelp",phone:"Call"}[reservationLink(r.backup).platform] || "Reserve")}</a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuModal({ restaurant, onClose }) {
  if (!restaurant) return null;
  const m = restaurant.menu || {};
  const sections = [
    ["Signature dishes", m.signature_dishes],
    ["Appetizers / small plates", m.appetizers],
    ["Mains", m.mains],
    ["Desserts", m.desserts],
    ["Wine & drinks", m.wine_and_drinks],
  ];
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 1000, padding: 0 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-background-primary)", maxWidth: "640px", width: "100%", maxHeight: "90vh", overflowY: "auto", borderRadius: "16px 16px 0 0", padding: "22px 22px 32px", boxShadow: "0 -8px 32px rgba(0,0,0,0.25)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, margin: 0 }}>Menu</p>
          <button
            onClick={onClose}
            aria-label="Close menu"
            style={{ background: "transparent", border: "none", fontSize: "22px", color: "var(--color-text-secondary)", cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}
          >×</button>
        </div>
        <p style={{ fontSize: "20px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)" }}>{restaurant.name}</p>
        {(restaurant.neighborhood || restaurant.cuisine || restaurant.price_range) && (
          <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 14px", letterSpacing: "0.02em" }}>
            {[restaurant.neighborhood, restaurant.cuisine, restaurant.price_range].filter(Boolean).join("  ·  ")}
          </p>
        )}
        {m.style_note && <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 14px", fontStyle: "italic", lineHeight: 1.55 }}>{m.style_note}</p>}
        {sections.map(([title, items]) => Array.isArray(items) && items.length > 0 && (
          <div key={title} style={{ marginBottom: "14px" }}>
            <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 8px", paddingBottom: "6px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{title}</p>
            {items.map((it, i) => {
              if (typeof it === "string") {
                return <p key={i} style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 6px", lineHeight: 1.5 }}>{it}</p>;
              }
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "12px", marginBottom: "8px", alignItems: "baseline" }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: 0, fontWeight: 500, lineHeight: 1.4 }}>{it.name}</p>
                    {it.description && <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "2px 0 0", lineHeight: 1.5 }}>{it.description}</p>}
                  </div>
                  {it.price && <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, whiteSpace: "nowrap" }}>{it.price}</p>}
                </div>
              );
            })}
          </div>
        ))}
        {m.source_note && <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", marginTop: "16px", fontStyle: "italic", lineHeight: 1.5 }}>{m.source_note}</p>}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <p style={{ fontSize: "11px", fontWeight: "600", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px", paddingBottom: "8px", borderBottom: `0.5px solid var(--color-border-tertiary)` }}>{title}</p>
      {children}
    </div>
  );
}

function ItineraryView({ data, onBack }) {
  const [menuRestaurant, setMenuRestaurant] = useState(null);
  return (
    <div>
      <MenuModal restaurant={menuRestaurant} onClose={() => setMenuRestaurant(null)} />
      <div style={{ marginBottom: "1.75rem" }}>
        <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: "600", margin: "0 0 6px" }}>Your trip</p>
        <p style={{ fontSize: "22px", fontWeight: "400", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)", letterSpacing: "-0.3px" }}>{data.destination}</p>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 1rem" }}>{data.meta}</p>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {data.logistics.map((l, i) => (
            <span key={i} style={{ fontSize: "12px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "4px 10px", color: "var(--color-text-secondary)" }}>{l}</span>
          ))}
        </div>
      </div>

      {data.days && data.days.length > 0 && (
        <Section title="Day-by-day">
          {data.days.map((d, i) => <DayBlock key={i} day={d} onOpenMenu={setMenuRestaurant} />)}
        </Section>
      )}

      {data.flags && data.flags.length > 0 && (
        <Section title="Constraint flags">
          {data.flags.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "6px", fontSize: "13px" }}>
              <Badge type="Flag" />
              <span style={{ color: "var(--color-text-secondary)" }}>{f}</span>
            </div>
          ))}
        </Section>
      )}

      {data.planb && data.planb.length > 0 && (
        <Section title="Plan B alternatives">
          {data.planb.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "6px", fontSize: "13px" }}>
              <Badge type="Plan B" />
              <span style={{ color: "var(--color-text-secondary)" }}>{p}</span>
            </div>
          ))}
        </Section>
      )}

      {data.snobs && data.snobs.length > 0 && (
        <Section title="Snob's guide">
          {data.snobs.map((s, i) => (
            <div key={i} style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "8px 12px", borderLeft: `2px solid #D4537E`, marginBottom: "8px", lineHeight: "1.6", borderRadius: 0 }}>{s}</div>
          ))}
        </Section>
      )}

      {data.tonight && data.tonight.length > 0 && (
        <Section title='"Do this tonight"'>
          <div style={{ background: GOLD_LIGHT, border: `1px solid #E4D5A8`, borderRadius: "var(--border-radius-md)", padding: "12px 14px" }}>
            {data.tonight.map((t, i) => (
              <div key={i} style={{ fontSize: "12px", color: GOLD_DARK, marginBottom: i < data.tonight.length - 1 ? "6px" : 0, display: "flex", gap: "6px" }}>
                <span>→</span><span>{t}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <button
        onClick={onBack}
        style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", color: "var(--color-text-secondary)", marginTop: "0.5rem" }}
      >← Plan another trip</button>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
      <label style={{ fontSize: "11px", color: "var(--color-text-secondary)", letterSpacing: "0.05em", fontWeight: "500", textTransform: "uppercase" }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: 0, fontStyle: "italic", lineHeight: "1.5" }}>{hint}</p>}
    </div>
  );
}

function Inp({ value, onChange, placeholder, type = "text" }) {
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", lineHeight: "1.4" }} />;
}

function DateInput({ value, onChange }) {
  // Native date input opens the OS calendar picker on click/tap.
  return (
    <input
      type="date"
      value={value}
      onChange={onChange}
      style={{
        fontSize: "14px",
        padding: "9px 0",
        border: "none",
        borderBottom: "0.5px solid var(--color-border-primary)",
        background: "transparent",
        color: value ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
        width: "100%",
        boxSizing: "border-box",
        outline: "none",
        fontFamily: "inherit",
        lineHeight: "1.4",
      }}
    />
  );
}

// Generic autocomplete: free-text input + filtered dropdown.
// `getSuggestions(q)` returns an array of items; `renderItem(item)` renders each row;
// `itemToValue(item)` converts a picked item to the string written into the input.
function Autocomplete({ value, onChange, placeholder, getSuggestions, renderItem, itemToValue, itemKey, openOnFocusEmpty = false, minChars = 1 }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef(null);

  const q = value.trim().toLowerCase();
  const suggestions = (q.length >= minChars || (openOnFocusEmpty && q.length === 0))
    ? getSuggestions(q).slice(0, 8)
    : [];

  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const pick = (item) => {
    onChange({ target: { value: itemToValue(item) } });
    setOpen(false);
    setActiveIdx(-1);
  };

  const onKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      pick(suggestions[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => { onChange(e); setOpen(true); setActiveIdx(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", lineHeight: "1.4" }}
      />
      {open && suggestions.length > 0 && (
        <div className="city-suggestions" role="listbox">
          {suggestions.map((item, i) => (
            <div
              key={itemKey(item)}
              role="option"
              aria-selected={i === activeIdx}
              className={`city-suggestion${i === activeIdx ? " active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(item); }}
            >
              {renderItem(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CityAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      getSuggestions={(q) => CITIES.filter(c =>
        c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q)
      )}
      renderItem={(c) => <>{c.name}<span className="country">{c.country}</span></>}
      itemToValue={(c) => `${c.name}, ${c.country}`}
      itemKey={(c) => `${c.name}-${c.country}`}
    />
  );
}

function AirportAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      getSuggestions={(q) => AIRPORTS.filter(a =>
        a.code.toLowerCase().includes(q) ||
        a.city.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q)
      )}
      renderItem={(a) => <>{a.code}<span className="country">{a.city} · {a.name}</span></>}
      itemToValue={(a) => a.code}
      itemKey={(a) => a.code}
    />
  );
}

function AirlineAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      getSuggestions={(q) => AIRLINES.filter(a => a.toLowerCase().includes(q))}
      renderItem={(a) => <>{a}</>}
      itemToValue={(a) => a}
      itemKey={(a) => a}
    />
  );
}

function HotelTierAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? HOTEL_TIERS.filter(h => h.toLowerCase().includes(q)) : HOTEL_TIERS}
      renderItem={(h) => <>{h}</>}
      itemToValue={(h) => h}
      itemKey={(h) => h}
    />
  );
}

function VehicleAutocomplete({ value, onChange, placeholder }) {
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? VEHICLE_TYPES.filter(v => v.toLowerCase().includes(q)) : VEHICLE_TYPES}
      renderItem={(v) => <>{v}</>}
      itemToValue={(v) => v}
      itemKey={(v) => v}
    />
  );
}

// Rental company — filters by region of the chosen home airport.
function RentalCompanyAutocomplete({ value, onChange, placeholder, airport }) {
  const list = getRentalCompanies(airport);
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? list.filter(c => c.name.toLowerCase().includes(q)) : list}
      renderItem={(c) => <>{c.name}{c.note && <span className="country">{c.note}</span>}</>}
      itemToValue={(c) => c.name}
      itemKey={(c) => c.name}
    />
  );
}

// Simple wrappers for plain string lists.
function makeSimpleAutocomplete(getList) {
  return function SimpleAutocomplete({ value, onChange, placeholder }) {
    return (
      <Autocomplete
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        openOnFocusEmpty={true}
        minChars={0}
        getSuggestions={(q) => {
          const list = typeof getList === "function" ? getList() : getList;
          return q ? list.filter(s => s.toLowerCase().includes(q)) : list;
        }}
        renderItem={(s) => <>{s}</>}
        itemToValue={(s) => s}
        itemKey={(s) => s}
      />
    );
  };
}

const TravelersAutocomplete = makeSimpleAutocomplete(TRAVELER_PRESETS);
const CuisineAutocomplete = makeSimpleAutocomplete(CUISINE_SUGGESTIONS);
const HotelMustHaveAutocomplete = makeSimpleAutocomplete(HOTEL_MUSTHAVE_SUGGESTIONS);
const InterestsAutocomplete = makeSimpleAutocomplete(INTEREST_SUGGESTIONS);

// Suggests neighborhoods/base areas for the chosen destination from the existing areaHints list.
function BaseAreaAutocomplete({ value, onChange, placeholder, destination }) {
  // Parse the hint string for the destination into an array of area names.
  const hint = getAreaHint(destination || "");
  // Strip the leading "e.g. " and split on commas.
  const areas = hint.replace(/^e\.g\.\s*/i, "").split(/,\s*/).map(s => s.trim()).filter(Boolean);
  return (
    <Autocomplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      openOnFocusEmpty={true}
      minChars={0}
      getSuggestions={(q) => q ? areas.filter(a => a.toLowerCase().includes(q)) : areas}
      renderItem={(a) => <>{a}</>}
      itemToValue={(a) => a}
      itemKey={(a) => a}
    />
  );
}

function Sel({ value, onChange, opts }) {
  return (
    <select value={value} onChange={onChange} style={{ fontSize: "13px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", appearance: "none", cursor: "pointer" }}>
      {opts.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

function TagInput({ placeholder, tags, setTags, suggestions = [] }) {
  const [val, setVal] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef(null);

  const q = val.trim().toLowerCase();
  const filtered = (suggestions || [])
    .filter(s => !tags.includes(s))
    .filter(s => q ? s.toLowerCase().includes(q) : true)
    .slice(0, 8);

  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const add = (v) => {
    const trimmed = (v || val).trim();
    if (trimmed && !tags.includes(trimmed)) setTags([...tags, trimmed]);
    setVal("");
    setOpen(false);
    setActiveIdx(-1);
  };

  const onKeyDown = (e) => {
    if (open && filtered.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); add(filtered[activeIdx]); return; }
      if (e.key === "Escape")    { setOpen(false); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); add(); }
  };

  return (
    <div>
      <div ref={wrapRef} style={{ display: "flex", gap: "8px", marginBottom: "8px", position: "relative" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            value={val}
            onChange={e => { setVal(e.target.value); setOpen(true); setActiveIdx(-1); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            style={{ width: "100%", fontSize: "13px", padding: "8px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", outline: "none", fontFamily: "inherit" }}
          />
          {open && filtered.length > 0 && (
            <div className="city-suggestions" role="listbox">
              {filtered.map((s, i) => (
                <div
                  key={s}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`city-suggestion${i === activeIdx ? " active" : ""}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={(e) => { e.preventDefault(); add(s); }}
                >{s}</div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => add()} style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "6px 12px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>+ Add</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
        {tags.map(t => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: "5px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "4px 10px", fontSize: "12px", color: "var(--color-text-primary)" }}>
            {t}
            <button onClick={() => setTags(tags.filter(x => x !== t))} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: "15px", padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "0.5px solid var(--color-border-tertiary)", gap: "12px" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>{label}</div>
        {desc && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{desc}</div>}
      </div>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ accentColor: GOLD, width: "15px", height: "15px", cursor: "pointer", flexShrink: 0 }} />
    </div>
  );
}

const cardStyle = { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", padding: "1.25rem 1.5rem", marginBottom: "1rem" };
const ctStyle = { fontSize: "11px", fontWeight: "500", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 1.1rem", paddingBottom: "10px", borderBottom: "0.5px solid var(--color-border-tertiary)" };
const g2 = { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", marginBottom: "16px" };
const g3 = { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)", gap: "14px", marginBottom: "16px" };

export default function TripOptimizer() {
  // Persisted form state — survives reloads and accidental tab closes.
  const LS_KEY = "trip-optimizer-form-v3";
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; } };
  const saved = loadSaved();

  // Sample prefill — June 4, 6 nights, United, Hertz, Marriott, food + wine focus.
  const DEFAULTS = {
    basics: { destination: "Santa Fe, NM", startDate: "2026-06-04", nights: "6", travelers: "2 adults", baseArea: "", style: "Food & wine", pace: "Moderate (2–3 things/day)", budget: "$$$ — mid range" },
    flights: { homeAirport: "EWR", airline: "United", cabin: "Business / Polaris", flex: "Exact date only" },
    hotel: { brand: "Marriott / Bonvoy", tier: "", mustHave: "" },
    transport: { type: "Rental car", company: "Hertz", vehicle: "" },
    dining: { cuisine: "Local / regional", budget: "$$$ — mid ($60–120pp)" },
    restaurants: [],
    activities: [],
    interests: { level: "Easy — mostly walking", text: "Good local food, food and wine culture focus" },
  };

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [streamPreview, setStreamPreview] = useState("");
  const [progress, setProgress] = useState(0);          // 0–1 estimated fraction
  const [progressLabel, setProgressLabel] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const abortRef = useRef(null);

  const [basics, setB] = useState(saved.basics || DEFAULTS.basics);
  const [flights, setF] = useState(saved.flights || DEFAULTS.flights);
  const [hotel, setH] = useState(saved.hotel || DEFAULTS.hotel);
  const [transport, setT] = useState(saved.transport || DEFAULTS.transport);
  const [dining, setD] = useState(saved.dining || DEFAULTS.dining);
  const [restaurants, setRest] = useState(saved.restaurants || DEFAULTS.restaurants);
  const [activities, setActs] = useState(saved.activities || DEFAULTS.activities);
  const [interests, setInt] = useState(saved.interests || DEFAULTS.interests);

  // Auto-save form on every change.
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ basics, flights, hotel, transport, dining, restaurants, activities, interests }));
    } catch {}
  }, [basics, flights, hotel, transport, dining, restaurants, activities, interests]);
  const [outputs, setOut] = useState({ itinerary: true, weather: true, navigation: true, logistics: true, tonight: true, menus: true, flags: true, planb: true, snobs: true, practical: false, badges: false, pronunciation: false });

  const togOut = k => setOut(o => ({ ...o, [k]: !o[k] }));
  const missing = [!basics.destination.trim() && "Destination", !basics.startDate.trim() && "Start date", !basics.nights.trim() && "Nights", !flights.homeAirport.trim() && "Home airport"].filter(Boolean);
  const ready = missing.length === 0;
  const areaHint = getAreaHint(basics.destination);
  const activeCount = Object.values(outputs).filter(Boolean).length;

  const buildSystemPrompt = () => `You are a luxury travel planner. Return ONLY valid JSON — no markdown, no backticks, no preamble.

Return this exact structure:
{
  "destination": "City, State/Country",
  "meta": "Dates · N nights · N travelers · Style",
  "logistics": ["Flight: EWR → SAF United", "Hotel: La Fonda on the Plaza", "Car: Hertz SUV"],
  "days": [
    {
      "label": "Day 1 · Thu Jun 4 · Arrive Santa Fe",
      "items": [
        { "type": "Flight", "text": "EWR → SAF via DEN, depart 09:30, arrive 14:45, United" },
        { "type": "Hotel", "text": "Check in · Eldorado Hotel & Spa, downtown" },
        { "type": "Activity", "text": "Sunset on the Plaza, gallery walk on Canyon Road" },
        {
          "type": "Dinner",
          "text": "Geronimo — Canyon Road, contemporary Southwest",
          "restaurant": {
            "name": "Geronimo",
            "neighborhood": "Canyon Road",
            "cuisine": "Contemporary Southwest",
            "price_range": "$$$$",
            "why": "Set in a 250-year-old adobe; the elk tenderloin and green-chile lobster tail are signature. Book the patio in summer.",
            "closure_note": "Open Thu. Confirm hours — some Santa Fe spots close Tue.",
            "reservation": { "platform": "opentable", "url": "https://www.opentable.com/r/geronimo-santa-fe" },
            "menu": {
              "style_note": "Modern Southwest with French technique. Tasting-menu vibe à la carte.",
              "signature_dishes": [
                { "name": "Mesquite-grilled elk tenderloin", "description": "Applewood-smoked bacon, garlic mashed potatoes, brandied mushroom sauce", "price": "$58" },
                { "name": "Green-chile lobster tail", "description": "Atlantic lobster, Hatch green chile cream, sweet corn", "price": "$72" }
              ],
              "appetizers": [
                { "name": "Heirloom tomato salad", "description": "Buffalo mozzarella, basil oil", "price": "$18" }
              ],
              "mains": [
                { "name": "Tellicherry-rubbed elk", "description": "See signature", "price": "$58" },
                { "name": "Diver scallops", "description": "Cauliflower pure, brown butter", "price": "$48" }
              ],
              "desserts": [
                { "name": "Warm chocolate tart", "description": "Espresso ice cream", "price": "$14" }
              ],
              "wine_and_drinks": [
                { "name": "Wine list", "description": "450+ bottles, strong New World focus, broad by-the-glass" },
                { "name": "Sgnt. cocktail: Smoked sage margarita" }
              ],
              "source_note": "Menu reconstructed from typical offerings; prices and items change seasonally — confirm at restaurant."
            },
            "backup": {
              "name": "The Compound",
              "neighborhood": "Canyon Road",
              "cuisine": "New American / Southwest",
              "price_range": "$$$$",
              "why": "Same Canyon Road caliber; James Beard–recognized chef. Easier to book last-minute than Geronimo.",
              "reservation": { "platform": "opentable", "url": "https://www.opentable.com/r/the-compound-santa-fe" },
              "menu": {
                "signature_dishes": [
                  { "name": "Tuna tartare", "price": "$24" },
                  { "name": "Roast chicken for two", "price": "$78" }
                ],
                "source_note": "Representative menu; confirm on arrival."
              }
            }
          }
        }
      ]
    }
  ],
  "flags": ["Geronimo books out 2–3 weeks ahead in summer", "Many Canyon Road galleries closed Sun/Mon"],
  "planb": ["If thunderstorms (common 3–5pm in summer): swap outdoor for Georgia O'Keeffe Museum"],
  "snobs": ["It's 'red or green?' on chile — 'Christmas' = both. Locals don't say 'chili'."],
  "tonight": ["Confirm Geronimo reservation for Day 1", "Verify Day 3 backup (The Compound) hours"]
}

CRITICAL RULES FOR RESTAURANTS:
1. EVERY "Dinner", "Lunch", "Breakfast", or "Brunch" item MUST include the full "restaurant" object with all fields above (name, neighborhood, cuisine, price_range, why, closure_note, reservation, menu, backup).
2. Compute the weekday for each day from the start date. EXCLUDE restaurants known to be typically closed that weekday (e.g., many fine-dining spots close Mon or Tue). If you're not sure of the closure day, put "Confirm hours — closure day uncertain" in closure_note.
3. ALWAYS include a same-tier "backup" restaurant in the same neighborhood / cuisine family for when the primary is fully booked.
4. Reservation platform must be one of: "opentable", "resy", "tock", "yelp", "phone", "walkin". Use OpenTable for most US/UK/EU mid-tier fine dining; Resy for trendy NYC/LA/Miami; Tock for tasting-menu / pre-paid spots; "phone" with a phone number for hole-in-the-wall spots; "walkin" if no reservations.
5. If you know the canonical reservation URL (e.g., https://www.opentable.com/r/<slug>), include it. Otherwise omit "url" and the app will build a search URL.
6. The menu must follow the exact schema: { style_note, signature_dishes, appetizers, mains, desserts, wine_and_drinks, source_note }. Each dish is { name, description, price } (description and price optional). Include the source_note acknowledging menus change.
7. Be specific, opinionated, insider-toned. Real restaurant names. Real dishes the restaurant is actually known for.

Generate ${basics.nights || 3} days. Compute the correct weekday for each day starting from the start date provided in the user message.`;

  const buildUserPrompt = () => {
    const active = Object.entries(outputs).filter(([, v]) => v).map(([k]) => k).join(", ");
    return `Plan this trip:
Destination: ${basics.destination}
Base area: ${basics.baseArea || "suggest best area"}
Start date: ${formatDateForDisplay(basics.startDate) || basics.startDate}
Nights: ${basics.nights}
Travelers: ${basics.travelers}
Style: ${basics.style} · Pace: ${basics.pace} · Budget: ${basics.budget}
Home airport: ${flights.homeAirport} · Airline: ${flights.airline || "no preference"} · Cabin: ${flights.cabin}
Hotel brand: ${hotel.brand}${hotel.tier ? ` · ${hotel.tier}` : ""} · Must-haves: ${hotel.mustHave || "none"}
Transport: ${transport.type}${transport.company ? ` · ${transport.company}` : ""}
Cuisine: ${dining.cuisine || "local"} · Dinner budget: ${dining.budget}
Restaurants requested: ${restaurants.length ? restaurants.join(", ") : "suggest"}
Activities requested: ${activities.length ? activities.join(", ") : "suggest based on style"}
Interests: ${interests.text || "not specified"} · Level: ${interests.level}
Include sections: ${active}`;
  };

  const handleCancel = () => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    setLoading(false);
    setLoadingMsg("");
    setStreamPreview("");
  };

  const handleBuild = async () => {
    setLoading(true);
    setError("");
    setStreamPreview("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);
    setLoadingMsg("Researching destination…");

    // Track elapsed time for the progress display.
    const startedAt = Date.now();
    const elapsedTimer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);

    // Expected output size for the progress estimate.
    // ~600 tokens of overhead + ~500 tokens per dinner (full menu+backup) + ~150 per other day item.
    const nightsNum = Math.max(1, parseInt(basics.nights || "3", 10) || 3);
    const expectedTokens = 800 + nightsNum * 700;

    // Rotating progress messages so users see motion during the long generation.
    const phases = [
      "Researching destination…",
      "Selecting hotels and neighborhoods…",
      "Building day-by-day itinerary…",
      "Picking restaurants and reservations…",
      "Adding insider notes and Plan B…",
      "Finalizing your plan…",
    ];
    let phaseIdx = 0;
    const phaseTimer = setInterval(() => {
      phaseIdx = Math.min(phaseIdx + 1, phases.length - 1);
      setLoadingMsg(phases[phaseIdx]);
    }, 7000);

    // Hard client timeout — 4 minutes. Richer restaurant payloads (full menus +
    // backup per dinner) can push a 6-night plan to ~2 min of streaming.
    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeout = setTimeout(() => controller.abort(new Error("Timed out after 4 minutes")), 240000);

    // Reassure the user after 60s that we're still working.
    const slowNotice = setTimeout(() => {
      setLoadingMsg(prev => prev.includes("longer") ? prev : "Still working — detailed plans can take 1–3 minutes…");
    }, 60000);

    try {
      const apiUrl = (typeof __API_BASE__ !== "undefined" ? __API_BASE__ : "") + "/api/chat";
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 8192,
          system: buildSystemPrompt(),
          messages: [{ role: "user", content: buildUserPrompt() }],
        }),
      });

      // Non-streaming error path: server returned JSON error.
      if (!response.ok) {
        const raw = await response.text();
        let msg = `Request failed (HTTP ${response.status})`;
        try {
          const j = JSON.parse(raw);
          msg = j?.error?.message || j?.message || msg;
        } catch { if (raw) msg = raw.slice(0, 240); }
        throw new Error(msg);
      }

      const ctype = response.headers.get("content-type") || "";

      // Collect the full text from either an SSE stream or a plain JSON response.
      let fullText = "";

      if (ctype.includes("text/event-stream") && response.body) {
        // Parse Anthropic SSE: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE events separated by \n\n; lines start with "data: "
          let nl;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const event = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const lines = event.split("\n");
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const evt = JSON.parse(payload);
                if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                  fullText += evt.delta.text || "";
                  setStreamPreview(fullText.slice(-400));

                  // Progress estimate — chars-based since we don't get token counts mid-stream.
                  // Rough conversion: ~3.5 chars/token; cap at 95% so the bar never claims done until message_stop.
                  const estTokens = fullText.length / 3.5;
                  const frac = Math.min(0.95, estTokens / expectedTokens);
                  setProgress(frac);

                  // Count completed day labels for a human-friendly counter.
                  const dayMatches = fullText.match(/"label"\s*:\s*"Day\s+\d+/g) || [];
                  const daysSeen = dayMatches.length;
                  if (daysSeen > 0) {
                    setProgressLabel(`Day ${Math.min(daysSeen, nightsNum + 1)} of ${nightsNum + 1}`);
                  } else if (fullText.length > 100) {
                    setProgressLabel("Building plan…");
                  }
                } else if (evt.type === "message_stop") {
                  setProgress(1);
                  setProgressLabel("Finalizing…");
                } else if (evt.type === "error" || evt.error) {
                  throw new Error(evt.error?.message || evt.message || "Stream error");
                }
              } catch (e) {
                // Ignore unparseable keepalive lines.
              }
            }
          }
        }
      } else {
        // Fallback: server returned non-streamed JSON.
        const raw = await response.text();
        try {
          const data = JSON.parse(raw);
          fullText = data.content?.find(b => b.type === "text")?.text || "";
        } catch { throw new Error("Server returned an unexpected response."); }
      }

      if (!fullText) throw new Error("No content returned from AI service.");

      // Robust JSON extraction — strip code fences, then look for outermost {...}.
      const clean = fullText.replace(/```json|```/g, "").trim();
      let jsonStr = clean;
      const first = clean.indexOf("{");
      const last = clean.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) jsonStr = clean.slice(first, last + 1);

      let parsed;
      try { parsed = JSON.parse(jsonStr); }
      catch { throw new Error("AI response was not valid JSON. Try again, or reduce nights / outputs."); }

      setResult(parsed);
      setStep(3);
    } catch (err) {
      const msg = err?.name === "AbortError"
        ? "Generation cancelled or timed out. Try again."
        : (err?.message || "Something went wrong generating the plan. Please try again.");
      setError(msg);
    } finally {
      clearInterval(phaseTimer);
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      clearTimeout(slowNotice);
      abortRef.current = null;
      setLoading(false);
      setLoadingMsg("");
      setStreamPreview("");
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  const outputDefs = [
    ["itinerary","Day-by-day itinerary","Full sequenced schedule with timing"],
    ["weather","Weather per day","Forecast strip with rain %, wind, sunrise / sunset"],
    ["navigation","One-tap navigation","Google Maps, Apple Maps, Waze on each driving day"],
    ["logistics","Logistics callout cards","Flights, hotel, car — each as a structured card"],
    ["tonight",'"Do this tonight" prompts',"Sequenced evening reminders keyed to the next day"],
    ["menus","Restaurant menu links","Inline menu link per dining recommendation"],
    ["flags","Constraint flags","Closed days, booking lead times, dead zones"],
    ["planb","Plan B alternatives","Fallbacks for weather cancellations or closures"],
    ["snobs","Snob's guide","Insider tone — what to know, skip, and say"],
    ["practical","Practical notes","Tipping, dress, connectivity, altitude"],
    ["badges","Personal recommendation badges","Flag places you've personally visited"],
    ["pronunciation","Pronunciation guide","Phonetic hints on unfamiliar place names"],
  ];

  return (
    <div style={{ fontFamily: "var(--font-sans)", color: "var(--color-text-primary)" }}>

      <div style={{ padding: "2rem 1.75rem 1.75rem", borderBottom: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)" }}>
        <p style={{ fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: "500", margin: "0 0 8px", color: "var(--color-text-secondary)" }}>Travel planning</p>
        <p style={{ fontSize: "28px", fontWeight: "400", margin: "0 0 6px", color: "var(--color-text-primary)", letterSpacing: "-0.5px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>Trip Optimizer</p>
        <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0 }}>Powered by <span style={{ color: GOLD, fontWeight: "500" }}>Barrier Island Digital</span></p>
        <hr style={{ border: "none", borderTop: `1px solid ${GOLD}`, width: "32px", margin: "14px 0 0" }} />
      </div>

      <div style={{ maxWidth: "640px", margin: "0 auto", padding: "1.75rem 1.25rem 2.5rem" }}>

        <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "1.75rem", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-text-secondary)" }}>
          {["Essentials", "Details", "Your plan"].map((s, i) => (
            <>
              <span key={s + "dot"} style={{ width: "8px", height: "8px", borderRadius: "50%", background: step >= i + 1 ? GOLD : "var(--color-border-secondary)", display: "inline-block", flexShrink: 0 }} />
              <span key={s} style={{ color: step >= i + 1 ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>{s}</span>
              {i < 2 && <span key={s + "sep"} style={{ color: "var(--color-border-secondary)", margin: "0 2px" }}>·</span>}
            </>
          ))}
        </div>

        {step === 1 && (
          <div>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "1.5rem", lineHeight: "1.65" }}>Four essentials to start. Refine the details after, or build immediately.</p>

            <div style={cardStyle}>
              <p style={ctStyle}>Where & when</p>
              <div style={g2}>
                <Field label="Destination"><CityAutocomplete value={basics.destination} onChange={e => setB({ ...basics, destination: e.target.value })} placeholder="Start typing a city…" /></Field>
                <Field label="Home airport"><AirportAutocomplete value={flights.homeAirport} onChange={e => setF({ ...flights, homeAirport: e.target.value })} placeholder="e.g. EWR" /></Field>
              </div>
              <div style={g3}>
                <Field label="Start date"><DateInput value={basics.startDate} onChange={e => setB({ ...basics, startDate: e.target.value })} /></Field>
                <Field label="Nights"><Inp value={basics.nights} onChange={e => setB({ ...basics, nights: e.target.value })} placeholder="7" /></Field>
                <Field label="Travelers"><TravelersAutocomplete value={basics.travelers} onChange={e => setB({ ...basics, travelers: e.target.value })} placeholder="2 adults" /></Field>
              </div>
              <Field label="Base area or neighborhood" hint={areaHint}>
                <BaseAreaAutocomplete value={basics.baseArea} onChange={e => setB({ ...basics, baseArea: e.target.value })} placeholder="Where in the destination?" destination={basics.destination} />
              </Field>
            </div>

            <button disabled={!ready} onClick={() => ready && setStep(2)}
              style={{ border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: ready ? "pointer" : "not-allowed", width: "100%", marginTop: "0.25rem", fontFamily: "inherit", background: ready ? "var(--color-text-primary)" : "var(--color-border-secondary)", color: "var(--color-background-primary)", opacity: ready ? 1 : 0.5 }}>
              Continue — Add Details →
            </button>
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "8px", textAlign: "center", minHeight: "16px", fontStyle: "italic" }}>
              {!ready ? `Still needed: ${missing.join(", ")}` : ""}
            </p>
            {ready && (
              <button onClick={handleBuild} style={{ color: GOLD, fontSize: "12px", cursor: "pointer", background: "none", border: "none", padding: 0, textDecoration: "underline", marginTop: "4px", display: "block", textAlign: "center", fontFamily: "inherit", fontStyle: "italic", width: "100%" }}>
                Build now with essentials only →
              </button>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "1.5rem", lineHeight: "1.65" }}>Fill in what you know. Leave anything blank and the planner will suggest.</p>

            <div style={cardStyle}>
              <p style={ctStyle}>Trip style</p>
              <div style={g3}>
                <Field label="Style"><Sel value={basics.style} onChange={e => setB({ ...basics, style: e.target.value })} opts={["Cultural / sightseeing","Golf / sport","Food & wine","Beach / relaxation","Adventure / outdoor","Mixed"]} /></Field>
                <Field label="Pace"><Sel value={basics.pace} onChange={e => setB({ ...basics, pace: e.target.value })} opts={["Relaxed (1–2 things/day)","Moderate (2–3 things/day)","Full (3–4 things/day)"]} /></Field>
                <Field label="Budget"><Sel value={basics.budget} onChange={e => setB({ ...basics, budget: e.target.value })} opts={["$$ — value","$$$ — mid range","$$$$ — luxury","$$$$$ — ultra high end"]} /></Field>
              </div>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Flights</p>
              <div style={g3}>
                <Field label="Preferred airline"><AirlineAutocomplete value={flights.airline} onChange={e => setF({ ...flights, airline: e.target.value })} placeholder="e.g. United" /></Field>
                <Field label="Cabin"><Sel value={flights.cabin} onChange={e => setF({ ...flights, cabin: e.target.value })} opts={["Business / Polaris","Premium economy","Economy"]} /></Field>
                <Field label="Date flexibility"><Sel value={flights.flex} onChange={e => setF({ ...flights, flex: e.target.value })} opts={["Exact date only","± 1 day","± 2 days"]} /></Field>
              </div>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Hotel</p>
              <div style={g2}>
                <Field label="Brand family"><Sel value={hotel.brand} onChange={e => setH({ ...hotel, brand: e.target.value })} opts={["Marriott / Bonvoy","Hilton Honors","Hyatt","IHG","Independent / boutique","No preference"]} /></Field>
                <Field label="Sub-brand or tier"><HotelTierAutocomplete value={hotel.tier} onChange={e => setH({ ...hotel, tier: e.target.value })} placeholder="e.g. Ritz-Carlton, W, Autograph" /></Field>
              </div>
              <Field label="Must-haves"><HotelMustHaveAutocomplete value={hotel.mustHave} onChange={e => setH({ ...hotel, mustHave: e.target.value })} placeholder="e.g. pool, walkable to dining" /></Field>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Ground transport</p>
              <div style={g3}>
                <Field label="Type"><Sel value={transport.type} onChange={e => setT({ ...transport, type: e.target.value })} opts={["Rental car","Private driver","Rideshare / taxi","Train / rail","No car needed"]} /></Field>
                <Field label="Preferred company"><RentalCompanyAutocomplete value={transport.company} onChange={e => setT({ ...transport, company: e.target.value })} placeholder="e.g. Hertz, Sixt" airport={flights.homeAirport} /></Field>
                <Field label="Vehicle type"><VehicleAutocomplete value={transport.vehicle} onChange={e => setT({ ...transport, vehicle: e.target.value })} placeholder="e.g. SUV, sedan" /></Field>
              </div>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Dining</p>
              <div style={g2}>
                <Field label="Cuisine preferences"><CuisineAutocomplete value={dining.cuisine} onChange={e => setD({ ...dining, cuisine: e.target.value })} placeholder="e.g. local, seafood, wine-focused" /></Field>
                <Field label="Per-dinner budget"><Sel value={dining.budget} onChange={e => setD({ ...dining, budget: e.target.value })} opts={["$$ — casual ($30–60pp)","$$$ — mid ($60–120pp)","$$$$ — fine dining ($120pp+)","Mixed"]} /></Field>
              </div>
              <TagInput placeholder="Add a restaurant or dining type" tags={restaurants} setTags={setRest} suggestions={getRestaurantSuggestions(basics.destination)} />
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Activities</p>
              <div style={g2}>
                <Field label="Physical level"><Sel value={interests.level} onChange={e => setInt({ ...interests, level: e.target.value })} opts={["Easy — mostly walking","Moderate — some hiking","Active — full days on feet"]} /></Field>
                <Field label="Interests"><InterestsAutocomplete value={interests.text} onChange={e => setInt({ ...interests, text: e.target.value })} placeholder="e.g. art, wine, architecture, golf" /></Field>
              </div>
              <TagInput placeholder="Add a specific activity" tags={activities} setTags={setActs} suggestions={getActivitySuggestions(basics.destination)} />
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>{`Output sections  ·  ${activeCount} of 12 active`}</p>
              {outputDefs.map(([k, l, d]) => <Toggle key={k} label={l} desc={d} checked={outputs[k]} onChange={() => togOut(k)} />)}
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "0.5rem" }}>
              <button onClick={() => setStep(1)} style={{ background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>← Back</button>
              {loading ? (
                <button onClick={handleCancel}
                  style={{ flex: 1, border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}>
                  Cancel
                </button>
              ) : (
                <button onClick={handleBuild} disabled={loading}
                  style={{ flex: 1, border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "var(--color-text-primary)", color: "var(--color-background-primary)" }}>
                  Build Trip Plan →
                </button>
              )}
            </div>
            {loading && (
              <div style={{ marginTop: "12px", padding: "12px 14px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary, #fafafa)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px", gap: "10px" }}>
                  <p style={{ fontSize: "12px", color: "var(--color-text-primary)", margin: 0, fontWeight: 500, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {progressLabel || loadingMsg || "Working…"}
                  </p>
                  <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {progress > 0 ? `${Math.round(progress * 100)}%` : ""}
                    {elapsedSec > 0 ? `  ·  ${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,'0')}` : ""}
                  </p>
                </div>
                {/* Real progress bar driven by token stream. Falls back to indeterminate stripe before first token arrives. */}
                <div style={{ height: "5px", borderRadius: "3px", background: "var(--color-border-tertiary, #eee)", overflow: "hidden", position: "relative" }}>
                  {progress > 0 ? (
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`, background: GOLD, transition: "width 0.3s ease-out", borderRadius: "3px" }} />
                  ) : (
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: GOLD, animation: "slideBar 1.6s ease-in-out infinite" }} />
                  )}
                </div>
                <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "6px 0 0" }}>{loadingMsg}</p>
                {streamPreview && (
                  <p style={{ fontSize: "10px", lineHeight: 1.5, color: "var(--color-text-tertiary, #999)", margin: "8px 0 0", fontFamily: "var(--font-mono, ui-monospace, monospace)", whiteSpace: "pre-wrap", maxHeight: "60px", overflow: "hidden" }}>…{streamPreview}</p>
                )}
              </div>
            )}
            {error && <p style={{ fontSize: "12px", color: "var(--color-text-danger, #c0392b)", marginTop: "8px", textAlign: "center" }}>{error}</p>}
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "10px", textAlign: "center", fontStyle: "italic" }}>Typical plan: 15–40 seconds. Itinerary streams as it's built.</p>
          </div>
        )}

        {step === 3 && result && (
          <ItineraryView data={result} onBack={() => { setStep(1); setResult(null); }} />
        )}

        {step !== 3 && (
          <>
            <hr style={{ border: "none", borderTop: "0.5px solid var(--color-border-tertiary)", margin: "1.75rem 0" }} />
            <div style={{ border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-lg)", padding: "1.25rem 1.5rem", background: "var(--color-background-primary)" }}>
              <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: "500", margin: "0 0 5px" }}>Your trip</p>
              <p style={{ fontSize: "20px", fontWeight: "400", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)" }}>{basics.destination || "Destination not set"}</p>
              <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, lineHeight: "1.6" }}>
                {[basics.baseArea, formatDateForDisplay(basics.startDate), basics.nights ? `${basics.nights} nights` : null, flights.homeAirport ? `from ${flights.homeAirport}` : null].filter(Boolean).join("  ·  ") || "Complete the form above"}
              </p>
              {(restaurants.length > 0 || activities.length > 0) && (
                <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: "10px", marginTop: "12px" }}>
                  <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: "500", marginBottom: "5px" }}>Added</p>
                  {[...restaurants, ...activities].map(t => (
                    <p key={t} style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "3px", display: "flex", gap: "6px" }}>
                      <span style={{ color: GOLD }}>—</span>{t}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textAlign: "center", paddingTop: "1.25rem", borderTop: "0.5px solid var(--color-border-tertiary)", marginTop: "1.75rem", letterSpacing: "0.06em" }}>
          Powered by <span style={{ color: GOLD, fontWeight: "500" }}>Barrier Island Digital</span>
        </div>

      </div>
    </div>
  );
}
