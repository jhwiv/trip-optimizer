import { useState, useEffect, useRef, useMemo, Fragment } from "react";

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
  // US — disambiguated by state where common name collisions exist.
  { name: "New York, NY", country: "USA" },
  { name: "Boston, MA", country: "USA" },
  { name: "Washington, DC", country: "USA" },
  { name: "Chicago, IL", country: "USA" },
  { name: "Miami, FL", country: "USA" },
  { name: "New Orleans, LA", country: "USA" },
  { name: "Charleston, SC", country: "USA" },
  { name: "Charleston, WV", country: "USA" },
  { name: "Savannah, GA", country: "USA" },
  { name: "Asheville, NC", country: "USA" },
  { name: "Greenville, SC", country: "USA" },
  { name: "Greenville, NC", country: "USA" },
  { name: "Nashville, TN", country: "USA" },
  { name: "Memphis, TN", country: "USA" },
  { name: "Atlanta, GA", country: "USA" },
  { name: "Austin, TX", country: "USA" },
  { name: "Dallas, TX", country: "USA" },
  { name: "Houston, TX", country: "USA" },
  { name: "San Antonio, TX", country: "USA" },
  { name: "Santa Fe, NM", country: "USA" },
  { name: "Taos, NM", country: "USA" },
  { name: "Albuquerque, NM", country: "USA" },
  { name: "Aspen, CO", country: "USA" },
  { name: "Denver, CO", country: "USA" },
  { name: "Boulder, CO", country: "USA" },
  { name: "Telluride, CO", country: "USA" },
  { name: "Vail, CO", country: "USA" },
  { name: "Park City, UT", country: "USA" },
  { name: "Salt Lake City, UT", country: "USA" },
  { name: "Jackson Hole, WY", country: "USA" },
  { name: "San Francisco, CA", country: "USA" },
  { name: "Los Angeles, CA", country: "USA" },
  { name: "San Diego, CA", country: "USA" },
  { name: "Santa Barbara, CA", country: "USA" },
  { name: "Carmel, CA", country: "USA" },
  { name: "Monterey, CA", country: "USA" },
  { name: "Palm Springs, CA", country: "USA" },
  { name: "Napa Valley, CA", country: "USA" },
  { name: "Sonoma, CA", country: "USA" },
  { name: "Lake Tahoe, CA/NV", country: "USA" },
  { name: "Las Vegas, NV", country: "USA" },
  { name: "Portland, OR", country: "USA" },
  { name: "Portland, ME", country: "USA" },
  { name: "Seattle, WA", country: "USA" },
  { name: "Maui, HI", country: "USA" },
  { name: "Kauai, HI", country: "USA" },
  { name: "Oahu, HI", country: "USA" },
  { name: "Big Island, HI", country: "USA" },
  { name: "Naples, FL", country: "USA" },
  { name: "Key West, FL", country: "USA" },
  { name: "Orlando, FL", country: "USA" },
  { name: "Sarasota, FL", country: "USA" },
  { name: "Philadelphia, PA", country: "USA" },
  { name: "Pittsburgh, PA", country: "USA" },
  { name: "Newport, RI", country: "USA" },
  { name: "Cape Cod, MA", country: "USA" },
  { name: "Nantucket, MA", country: "USA" },
  { name: "Martha’s Vineyard, MA", country: "USA" },
  { name: "Stowe, VT", country: "USA" },
  { name: "Burlington, VT", country: "USA" },
  { name: "Acadia, ME", country: "USA" },
  { name: "Bar Harbor, ME", country: "USA" },
  { name: "Kennebunkport, ME", country: "USA" },
  { name: "Hudson Valley, NY", country: "USA" },
  { name: "Hamptons, NY", country: "USA" },
  { name: "Saratoga Springs, NY", country: "USA" },
  { name: "Sedona, AZ", country: "USA" },
  { name: "Scottsdale, AZ", country: "USA" },
  { name: "Phoenix, AZ", country: "USA" },
  { name: "Tucson, AZ", country: "USA" },
  { name: "Sun Valley, ID", country: "USA" },
  { name: "Big Sky, MT", country: "USA" },
  { name: "Bozeman, MT", country: "USA" },
  { name: "Anchorage, AK", country: "USA" },
  { name: "Juneau, AK", country: "USA" },
  { name: "Detroit, MI", country: "USA" },
  { name: "Minneapolis, MN", country: "USA" },
  { name: "St. Louis, MO", country: "USA" },
  { name: "Kansas City, MO", country: "USA" },
  { name: "Louisville, KY", country: "USA" },
  { name: "Lexington, KY", country: "USA" },
  { name: "Baltimore, MD", country: "USA" },
  { name: "Annapolis, MD", country: "USA" },
  { name: "Raleigh-Durham, NC", country: "USA" },
  { name: "Wilmington, NC", country: "USA" },
  { name: "Outer Banks, NC", country: "USA" },
  { name: "Hilton Head, SC", country: "USA" },
  { name: "Charlottesville, VA", country: "USA" },
  { name: "Richmond, VA", country: "USA" },
  { name: "Virginia Beach, VA", country: "USA" },
  { name: "Seaside Park, NJ", country: "USA" },
  { name: "Cape May, NJ", country: "USA" },
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

// Return the matched key (e.g. "copenhagen") for a given destination string,
// or "" if no destination-specific bucket matched. We use the dining map as
// the canonical source; both dining and activity maps use the same keys.
function destinationKey(destination) {
  const d = (destination || "").toLowerCase();
  for (const k of Object.keys(RESTAURANT_BY_DEST)) {
    if (d.includes(k)) return k;
  }
  return "";
}

// Given an array of currently-added chips and the previous destination key,
// return which chips came from THAT destination's specific list and are NOT
// in the new destination's specific list (i.e. stale picks worth flagging).
function findStaleChips(chips, prevKey, newKey, byDestMap) {
  if (!prevKey || prevKey === newKey || !Array.isArray(chips) || chips.length === 0) return [];
  const prevList = byDestMap[prevKey] || [];
  const newList = newKey ? (byDestMap[newKey] || []) : [];
  return chips.filter(c => prevList.includes(c) && !newList.includes(c));
}

// Find chips that belong to SOME destination bucket other than the current
// destination's bucket. Returns { staleChips, sourceKey } where sourceKey is
// the bucket those chips came from (e.g. "santa fe"). Used at mount + when
// the destination changes to catch chips that don't belong to the current
// destination at all -- even if we never observed the destination transition.
function findOrphanedChips(chips, currentKey, byDestMap) {
  if (!Array.isArray(chips) || chips.length === 0) return { staleChips: [], sourceKey: "" };
  const currentList = currentKey ? (byDestMap[currentKey] || []) : [];
  // Tally which OTHER bucket each chip belongs to; pick the most-represented one as source.
  const tally = new Map(); // bucketKey -> count
  const staleByKey = new Map(); // bucketKey -> chips[]
  for (const chip of chips) {
    if (currentList.includes(chip)) continue;
    for (const [k, list] of Object.entries(byDestMap)) {
      if (k === currentKey) continue;
      if (list.includes(chip)) {
        tally.set(k, (tally.get(k) || 0) + 1);
        const arr = staleByKey.get(k) || [];
        arr.push(chip);
        staleByKey.set(k, arr);
        break;
      }
    }
  }
  if (tally.size === 0) return { staleChips: [], sourceKey: "" };
  // Pick the bucket with the most chips; ties broken by first-seen.
  let bestKey = "";
  let bestCount = 0;
  for (const [k, n] of tally) {
    if (n > bestCount) { bestCount = n; bestKey = k; }
  }
  return { staleChips: staleByKey.get(bestKey) || [], sourceKey: bestKey };
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

// Convert '08:30' or '8:30' to '8:30 AM' / '20:15' to '8:15 PM'. Pass through anything else.
function formatTime(t) {
  if (!t || typeof t !== "string") return "";
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${mm} ${ampm}`;
}

// Sort key: convert '08:30' → 830, '14:05' → 1405. Items without time sink to the end.
// Returns -1 when no time so callers can fall back to original index for a stable sort.
function timeKey(t) {
  if (!t || typeof t !== "string") return -1;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

function TimePill({ time, end_time }) {
  if (!time) return null;
  const t = formatTime(time);
  const et = end_time ? formatTime(end_time) : "";
  return (
    <span style={{
      display: "inline-block", fontSize: "11px", fontWeight: 600,
      color: "var(--color-text-primary)", background: "#F5EDD6",
      padding: "2px 7px", borderRadius: "3px", whiteSpace: "nowrap",
      letterSpacing: "0.02em", minWidth: "58px", textAlign: "center",
    }}>{et ? `${t} – ${et}` : t}</span>
  );
}

// Parse "Day 1 · Thu Jun 4 · Arrive Santa Fe" → "2026-06-04" (the date segment).
// Returns null if no date can be extracted. Year defaults to current year if
// not present (the label format doesn't usually include year).
function parseDayLabelToISODate(label) {
  if (!label || typeof label !== "string") return null;
  // Match patterns like "Thu Jun 4", "Mon Jun 14, 2026", "Jun 4", "June 4 2026"
  const m = label.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:[, ]+(\d{4}))?/i);
  if (!m) return null;
  const monthIdx = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[1].toLowerCase().slice(0, 3));
  if (monthIdx < 0) return null;
  const day = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Build a Google Flights deep-link for the route + date. Falls back to the
// generic flights search if airports or date are missing.
function buildGoogleFlightsUrl(fromIata, toIata, isoDate) {
  if (!fromIata || !toIata) return "https://www.google.com/travel/flights";
  const from = String(fromIata).toUpperCase();
  const to = String(toIata).toUpperCase();
  if (isoDate) {
    // Google Flights text-search URL: works reliably without their opaque tfs token.
    const q = encodeURIComponent(`Flights from ${from} to ${to} on ${isoDate}`);
    return `https://www.google.com/travel/flights?q=${q}`;
  }
  const q = encodeURIComponent(`Flights from ${from} to ${to}`);
  return `https://www.google.com/travel/flights?q=${q}`;
}

function FlightCard({ type, time, end_time, flight: f, text, flags, dayLabel }) {
  if (!f) return null;
  const route = [f.from_airport, f.to_airport].filter(Boolean).join(" → ");
  const stopLabel = f.nonstop ? "Nonstop" : (f.connection ? `Connect ${f.connection}` : "Connecting");
  const note = f.confirmation_note || "";
  const hasVerify = /verify/i.test(note);
  const carrierLower = (f.carrier || "").toLowerCase();
  // Multi-carrier strings like "SAS or Delta" — don't pick a single booking host;
  // user needs to pick the carrier first.
  const isMultiCarrier = / or | \/ |,/.test(f.carrier || "");
  const bookHost = isMultiCarrier ? null
    : carrierLower.includes("united") ? "united.com"
    : carrierLower.includes("delta") ? "delta.com"
    : carrierLower.includes("american") ? "aa.com"
    : carrierLower.includes("jetblue") ? "jetblue.com"
    : carrierLower.includes("southwest") ? "southwest.com"
    : carrierLower.includes("alaska") ? "alaskaair.com"
    : carrierLower.includes("sas") || carrierLower.includes("scandinavian") ? "flysas.com"
    : carrierLower.includes("british airways") || carrierLower === "ba" ? "britishairways.com"
    : carrierLower.includes("virgin") ? "virginatlantic.com"
    : carrierLower.includes("air france") ? "airfrance.com"
    : carrierLower.includes("klm") ? "klm.com"
    : carrierLower.includes("lufthansa") ? "lufthansa.com"
    : carrierLower.includes("swiss") ? "swiss.com"
    : carrierLower.includes("iberia") ? "iberia.com"
    : carrierLower.includes("ana") || carrierLower.includes("all nippon") ? "ana.co.jp"
    : carrierLower.includes("jal") || carrierLower.includes("japan airlines") ? "jal.com"
    : carrierLower.includes("cathay") ? "cathaypacific.com"
    : carrierLower.includes("korean") ? "koreanair.com"
    : carrierLower.includes("aer lingus") ? "aerlingus.com"
    : carrierLower.includes("ita") ? "itaspa.com"
    : carrierLower.includes("norse") ? "flynorse.com"
    : null;
  const bookUrl = bookHost ? `https://www.${bookHost}` : null;
  // Universal: flight_number is always null after the quality layer. Title shows carrier · route.
  const titleLine = `${f.carrier || "Carrier TBD"} · ${route}`;
  // Banner copy: priority is carrier-correction → airport suggestion → generic look-up.
  const overrideBanner = f._carrierOverride
    ? `App corrected carrier: ${f._originalCarrier || "the model's pick"} does not operate this nonstop. Use ${f.carrier} — confirm with the live lookup below.`
    : null;
  const airportBanner = (f._airportSuspect && f._airportSuggestion)
    ? `Closer airport: ${f._airportSuggestion.iata} (${f._airportSuggestion.name}) is ${f._airportSuggestion.drive} away — ${f._airportSuggestion.note}. Consider flying into ${f._airportSuggestion.iata} instead of ${f.to_airport}.`
    : null;
  // Always-on look-up CTA: build a Google Flights URL for the exact route + date.
  const isoDate = parseDayLabelToISODate(dayLabel);
  const lookupUrl = buildGoogleFlightsUrl(f.from_airport, f.to_airport, isoDate);
  const lookupLabel = `LOOK UP ACTUAL FLIGHT${f.from_airport && f.to_airport ? ` · ${f.from_airport}→${f.to_airport}` : ""}`;
  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <TimePill time={time} end_time={end_time} />
        <Badge type={type || "Flight"} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1, minWidth: 0 }}>
          {titleLine}
        </p>
      </div>
      {overrideBanner && (
        <p style={{ fontSize: "11px", color: "#B85C00", margin: "0 0 6px", lineHeight: 1.4, letterSpacing: "0.02em", fontWeight: 500, padding: "6px 8px", background: "rgba(184,92,0,0.06)", borderLeft: "2px solid #B85C00", borderRadius: "2px" }}>⚠︎ {overrideBanner}</p>
      )}
      {airportBanner && (
        <p style={{ fontSize: "11px", color: "#0F0F0F", margin: "0 0 6px", lineHeight: 1.4, letterSpacing: "0.02em", fontWeight: 600, padding: "6px 8px", background: "rgba(196,168,98,0.18)", borderLeft: `2px solid ${GOLD}`, borderRadius: "2px" }}>✈ {airportBanner}</p>
      )}
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "2px 0 6px", letterSpacing: "0.02em" }}>
        {f.depart_time ? `Approx depart ${formatTime(f.depart_time)}` : ""}{f.arrive_time ? ` · arrive ${formatTime(f.arrive_time)}` : ""}{f.duration ? `  ·  ${f.duration}` : ""}  ·  {stopLabel}
      </p>
      {(f.cabin || f.aircraft) && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "0 0 4px" }}>
          {[f.cabin, f.aircraft].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {note && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "4px 0 0", lineHeight: 1.5, fontStyle: "italic" }}>{note}</p>
      )}
      {/* Primary action: route-specific Google Flights lookup. Always shown. */}
      <div style={{ marginTop: "10px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <a href={lookupUrl} target="_blank" rel="noopener noreferrer"
           style={{ fontSize: "11px", padding: "8px 12px", borderRadius: "4px", border: `0.5px solid ${GOLD}`, background: GOLD, color: "#0F0F0F", textDecoration: "none", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 700, display: "inline-block" }}>
          {lookupLabel}
        </a>
        {bookUrl && (
          <a href={bookUrl} target="_blank" rel="noopener noreferrer"
             style={{ fontSize: "11px", padding: "7px 11px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, display: "inline-block" }}>
            Or book · {bookHost}
          </a>
        )}
      </div>
      <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: "6px 0 0", lineHeight: 1.4, letterSpacing: "0.02em", fontStyle: "italic" }}>
        Times and carrier shown are planning estimates. Always confirm the actual flight number on the live lookup before booking.
      </p>
      {text && !f.carrier && (
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "4px 0 0" }}>{text}</p>
      )}
      {Array.isArray(flags) && flags.length > 0 && (
        <div style={{ marginTop: "8px", paddingTop: "6px", borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
          {flags.map((fl, i) => (
            <p key={i} style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "2px 0", lineHeight: 1.4 }}>· {fl}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function HotelCard({ type, time, end_time, hotel: h, text }) {
  if (!h) return null;
  const mapsUrl = h.address ? `https://maps.google.com/?q=${encodeURIComponent(`${h.name || ""} ${h.address}`.trim())}` : null;
  const telUrl = h.phone ? `tel:${h.phone.replace(/[^0-9+]/g, "")}` : null;
  return (
    <div style={{ marginBottom: "12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "12px 14px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <TimePill time={time} end_time={end_time} />
        <Badge type={type || "Hotel"} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1, minWidth: 0 }}>{h.name || text}</p>
      </div>
      {h.address && (
        mapsUrl ? (
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 4px", textDecoration: "underline", textDecorationColor: "var(--color-border-tertiary)", textUnderlineOffset: "2px", display: "block" }}>{h.address}</a>
        ) : (
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 4px" }}>{h.address}</p>
        )
      )}
      {(h.check_in_time || h.check_out_time || h.room_type) && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", margin: "2px 0 4px" }}>
          {[
            h.check_in_time ? `Check-in ${formatTime(h.check_in_time)}` : "",
            h.check_out_time ? `Check-out ${formatTime(h.check_out_time)}` : "",
            h.room_type,
          ].filter(Boolean).join("  ·  ")}
        </p>
      )}
      {h.confirmation_note && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "4px 0 0", fontStyle: "italic" }}>{h.confirmation_note}</p>
      )}
      {(telUrl || mapsUrl) && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
          {telUrl && (
            <a href={telUrl} style={{ fontSize: "11px", padding: "6px 11px", borderRadius: "4px", border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, display: "inline-block" }}>Call · {h.phone}</a>
          )}
          {mapsUrl && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", padding: "6px 11px", borderRadius: "4px", border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", textDecoration: "none", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, display: "inline-block" }}>Open in Maps</a>
          )}
        </div>
      )}
    </div>
  );
}

function DayBlock({ day, dayIndex, onOpenMenu }) {
  // Sort items chronologically by `time`. Items without a time keep their
  // original order and sink to the end. Index is the stable tiebreaker.
  const sortedItems = (day?.items || [])
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const ka = timeKey(a.item?.time);
      const kb = timeKey(b.item?.time);
      if (ka === -1 && kb === -1) return a.idx - b.idx;
      if (ka === -1) return 1;
      if (kb === -1) return -1;
      if (ka !== kb) return ka - kb;
      return a.idx - b.idx;
    })
    .map(x => x.item);
  // Split the label like 'Day 1 · Thu Jun 4 · Arrive Santa Fe' into 3 parts when possible.
  const labelParts = (day?.label || "").split(" · ");
  const dayTag = labelParts[0] || `Day ${dayIndex + 1}`;
  const dateTag = labelParts[1] || "";
  const themeTag = labelParts.slice(2).join(" · ") || "";
  return (
    <div id={`day-${dayIndex + 1}`} style={{ scrollMarginTop: "60px", borderLeft: `2px solid ${GOLD}`, paddingLeft: "1rem", marginBottom: "1.75rem", borderRadius: 0 }}>
      <div style={{ marginBottom: "10px" }}>
        <p style={{ fontSize: "10.5px", fontWeight: 600, color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", margin: "0 0 2px" }}>{dayTag}{dateTag ? `  ·  ${dateTag}` : ""}</p>
        {themeTag && <p style={{ fontSize: "16px", fontWeight: 500, color: "var(--color-text-primary)", margin: "0 0 4px", letterSpacing: "-0.1px", lineHeight: 1.3 }}>{themeTag}</p>}
        {day?.headline && (
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "4px 0 6px", fontStyle: "italic", lineHeight: 1.5 }}>— {day.headline}</p>
        )}
        {(day?.weather || day?.pace_note) && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
            {day.weather && (
              <span style={{ fontSize: "10.5px", color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", padding: "3px 8px", letterSpacing: "0.02em" }}>☀ {day.weather}</span>
            )}
            {day.pace_note && (
              <span style={{ fontSize: "10.5px", color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", padding: "3px 8px", letterSpacing: "0.02em" }}>· {day.pace_note}</span>
            )}
          </div>
        )}
      </div>
      {sortedItems.map((item, i) => {
        // Structured flight → rich card.
        if (item.type === "Flight" && item.flight) {
          return <FlightCard key={i} type={item.type} time={item.time} end_time={item.end_time} flight={item.flight} text={item.text} flags={item.flags} dayLabel={day?.label} />;
        }
        // Structured hotel → rich card.
        if (item.type === "Hotel" && item.hotel) {
          return <HotelCard key={i} type={item.type} time={item.time} end_time={item.end_time} hotel={item.hotel} text={item.text} />;
        }
        // Dining items with a structured restaurant payload render as a rich card with a time pill.
        if (item.restaurant && (item.type === "Dinner" || item.type === "Lunch" || item.type === "Breakfast" || item.type === "Brunch" || item.type === "Dining")) {
          return (
            <div key={i}>
              {item.time && (
                <div style={{ marginBottom: "4px" }}>
                  <TimePill time={item.time} end_time={item.end_time} />
                </div>
              )}
              <RestaurantCard type={item.type} restaurant={item.restaurant} onOpenMenu={onOpenMenu} />
            </div>
          );
        }
        return (
          <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "7px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: "1.5", flexWrap: "wrap" }}>
            <TimePill time={item.time} end_time={item.end_time} />
            <Badge type={item.type} />
            <span style={{ color: "var(--color-text-secondary)", flex: 1, minWidth: 0 }}>
              {item.text}
              {item.location && (
                <span style={{ display: "block", fontSize: "11.5px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>{item.location}</span>
              )}
            </span>
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
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
        <Badge type={type} />
        <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", margin: 0, lineHeight: 1.3, flex: 1 }}>{r.name}</p>
        {r._isReturnVisit && (
          <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", border: `0.5px solid ${GOLD}`, borderRadius: "3px", whiteSpace: "nowrap" }}>Return visit</span>
        )}
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

function tonightPriority(s) {
  const t = (s || "").trim();
  if (/^⚠/.test(t) || /^must today/i.test(t)) return { rank: 0, label: "Must today", color: "#B85C00", bg: "#FFF1E0" };
  if (/^this week/i.test(t) || /^·\s*this week/i.test(t)) return { rank: 1, label: "This week", color: GOLD_DARK, bg: GOLD_LIGHT };
  if (/^anytime/i.test(t)) return { rank: 2, label: "Anytime", color: "var(--color-text-secondary)", bg: "var(--color-background-secondary)" };
  return { rank: 1, label: null, color: GOLD_DARK, bg: GOLD_LIGHT };
}
function stripTonightPrefix(s) {
  return (s || "")
    .replace(/^⚠︎?\s*Must today\s*[:—–-]?\s*/i, "")
    .replace(/^·?\s*This week\s*[:—–-]?\s*/i, "")
    .replace(/^Anytime\s*[:—–-]?\s*/i, "")
    .trim();
}

// Curated truth table for routes where the LLM frequently hallucinates. Each
// entry lists the carriers that ACTUALLY operate a nonstop today. If the
// model emits a flight whose carrier is not in this set, applyQualityLayer
// rewrites it. Keep keys sorted as "AAA-BBB" with the alphabetically smaller
// IATA first — lookup is direction-agnostic.
// Curated destination → airports lookup. Keyed on lowercase destination phrase
// (city, region, or attraction). Each entry lists airports in PREFERRED order:
// the closest viable airport first, fallbacks after. Each airport has IATA +
// approx ground-time-from-destination. Used by both the system prompt (so the
// model can pick correctly) and the post-processing validator (so the app
// flags wrong choices). Match is by `includes()` on the lowercased destination
// — "bar harbor" matches "Bar Harbor, Maine" and "Bar Harbor & Acadia".
const DEST_AIRPORTS = {
  "bar harbor": [
    { iata: "BHB", name: "Hancock County–Bar Harbor", drive: "15 min", note: "seasonal Cape Air/JetBlue from BOS; closest by far" },
    { iata: "BGR", name: "Bangor Intl", drive: "50 min", note: "daily mainline service from EWR/JFK/PHL/DCA; best year-round option" },
    { iata: "PWM", name: "Portland Jetport", drive: "3 h", note: "more flight options, but long drive" },
  ],
  "acadia": [
    { iata: "BHB", name: "Hancock County–Bar Harbor", drive: "15 min", note: "closest to park" },
    { iata: "BGR", name: "Bangor Intl", drive: "50 min", note: "more flight options" },
    { iata: "PWM", name: "Portland Jetport", drive: "3 h", note: "hub backup" },
  ],
  "santa fe": [
    { iata: "SAF", name: "Santa Fe Regional", drive: "15 min", note: "limited — American from DFW, United from DEN/ORD" },
    { iata: "ABQ", name: "Albuquerque Intl Sunport", drive: "1 h", note: "primary hub; most nonstops; usually the right call" },
  ],
  "taos": [
    { iata: "TAOS", name: "Taos Regional", drive: "15 min", note: "very limited" },
    { iata: "SAF", name: "Santa Fe", drive: "1.5 h", note: "some service" },
    { iata: "ABQ", name: "Albuquerque", drive: "2.5 h", note: "most reliable" },
  ],
  "jackson hole": [
    { iata: "JAC", name: "Jackson Hole", drive: "15 min", note: "direct nonstops from many hubs" },
    { iata: "SLC", name: "Salt Lake City", drive: "5 h", note: "only if JAC is full/expensive" },
  ],
  "aspen": [
    { iata: "ASE", name: "Aspen/Pitkin", drive: "10 min", note: "seasonal service, weather-sensitive" },
    { iata: "EGE", name: "Eagle/Vail", drive: "1.25 h", note: "more reliable winter option" },
    { iata: "DEN", name: "Denver", drive: "4 h", note: "last resort" },
  ],
  "vail": [
    { iata: "EGE", name: "Eagle/Vail", drive: "45 min", note: "nonstops from many hubs in ski season" },
    { iata: "DEN", name: "Denver", drive: "2 h", note: "year-round backup" },
  ],
  "sun valley": [
    { iata: "SUN", name: "Friedman Memorial", drive: "15 min", note: "Alaska/United/Delta seasonal" },
    { iata: "BOI", name: "Boise", drive: "2.5 h", note: "more options" },
  ],
  "big sky": [
    { iata: "BZN", name: "Bozeman Yellowstone", drive: "1 h", note: "closest — nonstops year-round" },
  ],
  "yellowstone": [
    { iata: "BZN", name: "Bozeman", drive: "1.5 h", note: "north entrance — most flight options" },
    { iata: "JAC", name: "Jackson Hole", drive: "1 h", note: "south entrance" },
    { iata: "COD", name: "Cody", drive: "1 h", note: "east entrance — limited service" },
  ],
  "glacier national": [
    { iata: "FCA", name: "Glacier Park / Kalispell", drive: "30 min", note: "closest" },
    { iata: "GPI", name: "Glacier Park (same as FCA)", drive: "30 min", note: "" },
  ],
  "napa": [
    { iata: "STS", name: "Charles M. Schulz / Sonoma County", drive: "45 min", note: "smaller; Alaska/Avelo" },
    { iata: "SFO", name: "San Francisco", drive: "1.5 h", note: "most flight options" },
    { iata: "OAK", name: "Oakland", drive: "1.5 h", note: "backup" },
  ],
  "sonoma": [
    { iata: "STS", name: "Sonoma County", drive: "30 min", note: "closest" },
    { iata: "SFO", name: "San Francisco", drive: "1.5 h", note: "more options" },
  ],
  "martha's vineyard": [
    { iata: "MVY", name: "Martha's Vineyard", drive: "on-island", note: "closest — JetBlue/Delta seasonal from BOS/JFK/EWR" },
    { iata: "HYA", name: "Hyannis", drive: "ferry from Hyannis", note: "connect via ferry" },
    { iata: "BOS", name: "Boston", drive: "3 h + ferry", note: "if seasonal flights to MVY unavailable" },
  ],
  "nantucket": [
    { iata: "ACK", name: "Nantucket Memorial", drive: "on-island", note: "JetBlue/Delta/American seasonal" },
    { iata: "BOS", name: "Boston", drive: "3 h + ferry", note: "backup" },
  ],
  "hamptons": [
    { iata: "HTO", name: "East Hampton", drive: "15 min", note: "private/charter" },
    { iata: "ISP", name: "Long Island MacArthur", drive: "1.25 h", note: "Southwest/Frontier" },
    { iata: "JFK", name: "JFK", drive: "2.5 h", note: "most options" },
  ],
  "montauk": [
    { iata: "MTP", name: "Montauk", drive: "5 min", note: "GA only" },
    { iata: "ISP", name: "Long Island MacArthur", drive: "2 h", note: "limited" },
    { iata: "JFK", name: "JFK", drive: "3 h", note: "most options" },
  ],
  "cape cod": [
    { iata: "HYA", name: "Hyannis (Barnstable)", drive: "central Cape", note: "Cape Air seasonal" },
    { iata: "PVC", name: "Provincetown", drive: "P-town only", note: "Cape Air from BOS" },
    { iata: "BOS", name: "Boston", drive: "1.5–2.5 h", note: "most flight options" },
  ],
  "newport rhode": [
    { iata: "PVD", name: "T.F. Green / Providence", drive: "40 min", note: "closest" },
    { iata: "BOS", name: "Boston", drive: "1.5 h", note: "more options" },
  ],
  "hilton head": [
    { iata: "HHH", name: "Hilton Head", drive: "on-island", note: "AA/Delta/United from major hubs" },
    { iata: "SAV", name: "Savannah", drive: "50 min", note: "more options" },
  ],
  "savannah": [
    { iata: "SAV", name: "Savannah/Hilton Head", drive: "20 min", note: "primary" },
  ],
  "asheville": [
    { iata: "AVL", name: "Asheville Regional", drive: "20 min", note: "primary — nonstops from many east-coast hubs" },
    { iata: "CLT", name: "Charlotte", drive: "2 h", note: "backup" },
  ],
  "charleston": [
    { iata: "CHS", name: "Charleston Intl", drive: "20 min", note: "primary" },
  ],
  "key west": [
    { iata: "EYW", name: "Key West Intl", drive: "10 min", note: "AA/Delta/United/Silver from major hubs" },
    { iata: "MIA", name: "Miami", drive: "3.5 h", note: "if EYW pricey or sold out" },
  ],
  "jackson wyoming": [
    { iata: "JAC", name: "Jackson Hole", drive: "15 min", note: "primary" },
  ],
  "park city": [
    { iata: "SLC", name: "Salt Lake City", drive: "40 min", note: "primary — no closer airport" },
  ],
  "telluride": [
    { iata: "TEX", name: "Telluride Regional", drive: "15 min", note: "weather-sensitive seasonal" },
    { iata: "MTJ", name: "Montrose", drive: "1.5 h", note: "more reliable winter option" },
  ],
  "steamboat": [
    { iata: "HDN", name: "Yampa Valley / Hayden", drive: "30 min", note: "ski season nonstops" },
    { iata: "DEN", name: "Denver", drive: "3 h", note: "backup" },
  ],
  "hallstatt": [
    { iata: "SZG", name: "Salzburg", drive: "1 h", note: "closest — European budget hub" },
    { iata: "VIE", name: "Vienna", drive: "3 h", note: "more transatlantic options" },
    { iata: "MUC", name: "Munich", drive: "3 h", note: "transatlantic backup" },
  ],
  "interlaken": [
    { iata: "BRN", name: "Bern", drive: "1 h", note: "limited service" },
    { iata: "ZRH", name: "Zurich", drive: "2 h", note: "primary international gateway" },
    { iata: "GVA", name: "Geneva", drive: "2.5 h", note: "international gateway" },
  ],
  "st. moritz": [
    { iata: "SMV", name: "Samedan / St. Moritz", drive: "15 min", note: "GA/private only" },
    { iata: "ZRH", name: "Zurich", drive: "3.5 h", note: "primary" },
  ],
  "zermatt": [
    { iata: "GVA", name: "Geneva", drive: "3.5 h + train", note: "primary — Zermatt is car-free, take Glacier Express train" },
    { iata: "ZRH", name: "Zurich", drive: "3.5 h + train", note: "backup" },
  ],
  "chamonix": [
    { iata: "GVA", name: "Geneva", drive: "1.25 h", note: "closest international" },
  ],
  "reykjavik": [
    { iata: "KEF", name: "Keflavík", drive: "45 min", note: "all international flights" },
  ],
  "cinque terre": [
    { iata: "PSA", name: "Pisa", drive: "1.5 h", note: "closest" },
    { iata: "FLR", name: "Florence", drive: "2.5 h", note: "if Pisa unavailable" },
    { iata: "GOA", name: "Genoa", drive: "1.5 h", note: "backup" },
  ],
  "tuscany": [
    { iata: "FLR", name: "Florence", drive: "central", note: "primary" },
    { iata: "PSA", name: "Pisa", drive: "1 h", note: "budget carriers" },
  ],
  "amalfi": [
    { iata: "NAP", name: "Naples", drive: "1.5 h", note: "primary" },
  ],
  "positano": [
    { iata: "NAP", name: "Naples", drive: "1.5 h", note: "primary" },
  ],
  "capri": [
    { iata: "NAP", name: "Naples", drive: "+ ferry", note: "primary" },
  ],
  "sicily": [
    { iata: "CTA", name: "Catania", drive: "east coast", note: "main eastern gateway" },
    { iata: "PMO", name: "Palermo", drive: "west coast", note: "main western gateway" },
  ],
  "mallorca": [
    { iata: "PMI", name: "Palma de Mallorca", drive: "30 min", note: "only airport" },
  ],
  "ibiza": [
    { iata: "IBZ", name: "Ibiza", drive: "20 min", note: "only airport" },
  ],
  "mykonos": [
    { iata: "JMK", name: "Mykonos", drive: "15 min", note: "only airport" },
  ],
  "santorini": [
    { iata: "JTR", name: "Santorini", drive: "20 min", note: "only airport" },
  ],
};

const KNOWN_NONSTOPS = {
  // Transatlantic
  "CPH-EWR": ["SAS"],
  "CPH-JFK": ["SAS", "Norse Atlantic"],
  "EWR-ZRH": ["United", "Swiss", "Swiss International"],
  "JFK-ZRH": ["Swiss", "Swiss International", "Delta"],
  "EWR-LHR": ["United", "British Airways", "Virgin Atlantic"],
  "JFK-LHR": ["British Airways", "American", "Delta", "Virgin Atlantic", "JetBlue"],
  "CDG-JFK": ["Air France", "Delta", "American", "French Bee"],
  "CDG-EWR": ["United", "Air France"],
  "EWR-FRA": ["United", "Lufthansa"],
  "FRA-JFK": ["Lufthansa", "Singapore Airlines", "Condor"],
  "AMS-EWR": ["United", "KLM"],
  "AMS-JFK": ["KLM", "Delta"],
  "EWR-MUC": ["United", "Lufthansa"],
  "JFK-MUC": ["Lufthansa", "Delta"],
  "DUB-EWR": ["United", "Aer Lingus"],
  "DUB-JFK": ["Aer Lingus", "Delta", "JetBlue"],
  "FCO-JFK": ["ITA Airways", "Delta", "American"],
  "EWR-FCO": ["United", "ITA Airways"],
  "BCN-EWR": ["United"],
  "BCN-JFK": ["American", "Delta", "Iberia"],
  "JFK-MAD": ["Iberia", "American", "Delta", "Air Europa"],
  "EWR-MAD": ["United", "Iberia"],
  // Transpacific
  "HND-JFK": ["ANA", "Japan Airlines", "Delta", "American"],
  "JFK-NRT": ["ANA", "Japan Airlines"],
  "HND-LAX": ["ANA", "Japan Airlines", "Delta", "American", "United"],
  "LAX-NRT": ["ANA", "Japan Airlines", "United", "Singapore Airlines"],
  "HKG-JFK": ["Cathay Pacific"],
  "HKG-LAX": ["Cathay Pacific", "American"],
  "ICN-JFK": ["Korean Air", "Asiana"],
  "ICN-LAX": ["Korean Air", "Asiana", "Delta"],
};

// Carrier-name aliases so a model emitting "Scandinavian Airlines System" or
// "BA" still matches an entry that says "SAS" / "British Airways".
const CARRIER_ALIASES = {
  "sas": ["scandinavian", "sas"],
  "scandinavian airlines": ["sas", "scandinavian"],
  "british airways": ["ba", "british"],
  "ba": ["british airways", "british"],
  "american": ["american airlines", "aa"],
  "american airlines": ["american", "aa"],
  "united": ["united airlines", "ua"],
  "united airlines": ["united", "ua"],
  "delta": ["delta air lines", "dl"],
  "virgin atlantic": ["virgin"],
  "japan airlines": ["jal"],
  "jal": ["japan airlines"],
  "ana": ["all nippon", "all nippon airways"],
  "all nippon": ["ana"],
  "swiss": ["swiss international", "swiss air"],
  "singapore airlines": ["singapore"],
  "cathay pacific": ["cathay"],
  "korean air": ["korean"],
  "ita airways": ["ita", "alitalia"],
  "norse atlantic": ["norse"],
  "aer lingus": ["aerlingus"],
};

function routeKey(a, b) {
  if (!a || !b) return null;
  const x = String(a).toUpperCase().trim();
  const y = String(b).toUpperCase().trim();
  if (x === y) return null;
  return [x, y].sort().join("-");
}

// Look up the curated airport list for a destination string. Tries the most
// specific match first (longest matching key wins) so "South Lake Tahoe" picks
// the Tahoe entry rather than nothing. Returns null if no entry matches.
function lookupDestAirports(destination) {
  if (!destination || typeof destination !== "string") return null;
  const d = destination.toLowerCase();
  let bestKey = null;
  for (const key of Object.keys(DEST_AIRPORTS)) {
    if (d.includes(key)) {
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? { key: bestKey, airports: DEST_AIRPORTS[bestKey] } : null;
}

function carrierMatchesKnown(carrier, knownList) {
  if (!carrier || !Array.isArray(knownList)) return false;
  const c = carrier.toLowerCase();
  for (const k of knownList) {
    const kl = k.toLowerCase();
    if (c.includes(kl) || kl.includes(c)) return true;
    const aliases = CARRIER_ALIASES[kl] || [];
    for (const a of aliases) {
      if (c.includes(a) || a.includes(c)) return true;
    }
  }
  return false;
}

// Pass-three quality layer: dedupe restaurant repeats with an explicit
// "Return to X for [meal]" annotation, and surface a QC summary of any
// fixes/warnings the renderer applied so the user knows the app is on it.
// Pure: never mutates input — returns { data, qc }.
function applyQualityLayer(input, inputs) {
  if (!input || typeof input !== "object") return { data: input, qc: { fixes: [], warnings: [] } };
  const fixes = [];
  const warnings = [];

  // Deep-clone the bits we'll touch so renderer mutation is safe.
  const days = Array.isArray(input.days)
    ? input.days.map(d => ({ ...d, items: Array.isArray(d.items) ? d.items.map(it => ({ ...it, restaurant: it.restaurant ? { ...it.restaurant } : it.restaurant, flight: it.flight ? { ...it.flight } : it.flight })) : d.items }))
    : input.days;

  // 1. Restaurant dedupe → annotate the 2nd+ visit so the user understands the repeat is intentional.
  if (Array.isArray(days)) {
    const seen = new Map(); // normalized name → { dayIndex, mealType }
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        const r = item.restaurant;
        const isMeal = /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(item.type || "");
        if (!r || !r.name || !isMeal) return;
        const key = r.name.trim().toLowerCase();
        const prior = seen.get(key);
        if (prior) {
          const mealLabel = (item.type || "meal").toLowerCase();
          const note = `Return visit — first appeared Day ${prior.dayIndex + 1} (${prior.mealType.toLowerCase()}).`;
          if (r.why && !/^return visit/i.test(r.why)) {
            r.why = `${note} ${r.why}`;
          } else if (!r.why) {
            r.why = note;
          }
          r._isReturnVisit = true;
          fixes.push(`Annotated repeat: ${r.name} (Day ${dayIdx + 1} ${mealLabel}) — first on Day ${prior.dayIndex + 1}`);
        } else {
          seen.set(key, { dayIndex: dayIdx, mealType: item.type || "meal" });
        }
      });
    });
  }

  // 2. Flight verify-microcopy: if note doesn't end with the verify sentence, append it (model+renderer defense layered).
  if (Array.isArray(days)) {
    const VERIFY = "Verify flight number, times and equipment at booking — schedules change.";
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        if (item.type === "Flight" && item.flight) {
          const note = item.flight.confirmation_note || "";
          if (!/verify/i.test(note)) {
            // Ensure clean sentence boundary before appending.
            const trimmed = note.trim();
            const needsPeriod = trimmed && !/[.!?]$/.test(trimmed);
            item.flight.confirmation_note = trimmed
              ? `${trimmed}${needsPeriod ? "." : ""} ${VERIFY}`
              : VERIFY;
            // Mark so the renderer can keep the amber banner styling for emphasis.
            item.flight._verifyAppended = true;
            fixes.push(`Appended verify-at-booking microcopy to Day ${dayIdx + 1} flight`);
          }
        }
      });
    });
  }

  // 2b. UNIVERSAL flight-number strip. The model cannot be trusted to know
  // specific published flight numbers — even for routes it gets the carrier
  // right on, the number is usually fabricated. Strip every flight_number
  // unconditionally and force the renderer to surface a "Look up actual
  // flight" CTA. This is route-agnostic and applies to every flight, every
  // trip, no allowlist required.
  if (Array.isArray(days)) {
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        if (item.type !== "Flight" || !item.flight) return;
        const f = item.flight;
        if (f.flight_number != null && String(f.flight_number).trim() !== "") {
          f._originalFlightNumber = f.flight_number;
          f.flight_number = null;
          f._flightNumberStripped = true;
          fixes.push(`Day ${dayIdx + 1} flight: removed model-supplied flight number — look up live schedule`);
        }
      });
    });
  }

  // 2c. KNOWN_NONSTOPS carrier-correction (route-specific bonus layer). If the
  // model also got the carrier wrong on a route we know about, fix it. This
  // runs AFTER the universal number strip, so flight_number is already null.
  if (Array.isArray(days)) {
    days.forEach((day, dayIdx) => {
      (day.items || []).forEach(item => {
        if (item.type !== "Flight" || !item.flight) return;
        const f = item.flight;
        if (f.nonstop === false) return; // model already says connecting, trust it
        const key = routeKey(f.from_airport, f.to_airport);
        if (!key || !KNOWN_NONSTOPS[key]) return;
        const known = KNOWN_NONSTOPS[key];
        if (carrierMatchesKnown(f.carrier, known)) return; // carrier is legit for this route

        // Mismatch — rewrite.
        const claimedCarrier = f.carrier || "the listed carrier";
        const allCorrect = known.slice(0, 3);
        f._originalCarrier = f.carrier;
        f._originalConfirmationNote = f.confirmation_note;
        f.carrier = allCorrect.length > 1 ? allCorrect.join(" or ") : allCorrect[0];
        f._carrierOverride = true;
        const VERIFY_SENT = "Verify flight number, times and equipment at booking — schedules change.";
        f.confirmation_note = `Book directly with ${allCorrect[0]}. ${VERIFY_SENT}`;
        item.flags = Array.isArray(item.flags) ? item.flags.slice() : [];
        const operators = allCorrect.length > 1 ? `${allCorrect.join(" / ")} are the` : `${allCorrect[0]} is the`;
        item.flags.push(`Carrier corrected: ${claimedCarrier} does not operate a nonstop ${f.from_airport}→${f.to_airport}. ${operators} actual nonstop operator${allCorrect.length > 1 ? "s" : ""}.`);
        fixes.push(`Day ${dayIdx + 1} flight: corrected carrier (${claimedCarrier} → ${f.carrier}) for ${f.from_airport}→${f.to_airport}`);
      });
    });
  }

  // 2d. ARRIVAL AIRPORT VALIDATION. The model frequently picks a big hub (BOS,
  // SFO, MIA) when a much closer regional airport exists (BHB for Bar Harbor,
  // STS for Sonoma, EYW for Key West). Cross-check the destination against the
  // curated DEST_AIRPORTS map. If the model's pick isn't the top choice, ADD a
  // visible flag listing the better option — we do NOT silently rewrite the
  // airport because that would invalidate the rest of the itinerary (timing,
  // ground transport, etc). The user sees the suggestion and decides.
  if (Array.isArray(days) && inputs) {
    const cities = Array.isArray(inputs?.basics?.cities) ? inputs.basics.cities : [];
    const destStrings = cities.length
      ? cities.map(c => c?.name).filter(Boolean)
      : [inputs?.basics?.destination].filter(Boolean);
    if (destStrings.length) {
      days.forEach((day, dayIdx) => {
        (day.items || []).forEach(item => {
          if (item.type !== "Flight" || !item.flight) return;
          const f = item.flight;
          // Try to figure out which destination this flight is heading INTO.
          // The day.city field, when present, is most reliable. Otherwise we
          // pick the destination whose curated airport list contains the
          // flight's to_airport — if none match, the model's pick is suspect.
          const arrCity = day.city || null;
          const candidates = arrCity
            ? [arrCity]
            : destStrings;
          for (const c of candidates) {
            const lookup = lookupDestAirports(c);
            if (!lookup) continue;
            const top = lookup.airports[0];
            const validIatas = lookup.airports.map(a => a.iata.toUpperCase());
            const pick = (f.to_airport || "").toUpperCase();
            if (!pick) continue;
            // Skip departures FROM this city (returning home). We only validate
            // arrivals into the destination.
            if ((f.from_airport || "").toUpperCase() === pick) continue;
            // If the model's pick isn't in our curated list at all, surface it.
            if (!validIatas.includes(pick)) {
              item.flags = Array.isArray(item.flags) ? item.flags.slice() : [];
              item.flags.push(`Closer airport available for ${c}: ${top.iata} (${top.name}) — ${top.drive} from ${c}. App suggests checking ${top.iata} instead of ${pick}.`);
              fixes.push(`Day ${dayIdx + 1} flight: flagged ${pick} — ${top.iata} is closer to ${c}`);
              f._airportSuspect = true;
              f._airportSuggestion = top;
              break;
            }
            // If the model picked a fallback when the top choice exists, surface it too
            // (e.g. BOS when BHB or BGR is the right call).
            const pickIndex = validIatas.indexOf(pick);
            if (pickIndex > 0) {
              item.flags = Array.isArray(item.flags) ? item.flags.slice() : [];
              const closer = lookup.airports.slice(0, pickIndex);
              const closerList = closer.map(a => `${a.iata} (${a.drive})`).join(", ");
              item.flags.push(`Closer airport available for ${c}: ${closerList}. App suggests ${top.iata} — ${top.note}. Current pick ${pick} is ${lookup.airports[pickIndex].drive} away.`);
              fixes.push(`Day ${dayIdx + 1} flight: flagged ${pick} — ${top.iata} is closer to ${c}`);
              f._airportSuspect = true;
              f._airportSuggestion = top;
              break;
            }
            // pickIndex === 0 — model got the top choice. Nothing to flag.
            break;
          }
        });
      });
    }
  }

  // 3. Validators — surface as warnings, never block render.
  const planbLen = Array.isArray(input.planb) ? input.planb.length : 0;
  if (planbLen < 5) warnings.push(`Plan B has only ${planbLen} entries (expected ≥5)`);
  if (!input.weather_window) warnings.push("Missing weather_window summary");
  if (!Array.isArray(input.pack) || input.pack.length < 3) warnings.push("Pack list shorter than 3 items");
  if (Array.isArray(days)) {
    days.forEach((d, i) => {
      if (!d.headline) warnings.push(`Day ${i + 1} missing headline`);
      if (!d.weather) warnings.push(`Day ${i + 1} missing weather line`);
    });
  }

  return { data: { ...input, days }, qc: { fixes, warnings } };
}

// Small QC chip surfaced below the trip — shows we caught and fixed something
// instead of silently letting it through. Hidden when there's nothing to say.
function QualityBadge({ qc }) {
  if (!qc || (qc.fixes.length === 0 && qc.warnings.length === 0)) return null;
  return (
    <div style={{ marginTop: "1rem", marginBottom: "1.25rem", padding: "10px 12px", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary)" }}>
      <p style={{ fontSize: "10px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 6px" }}>Quality check</p>
      {qc.fixes.length > 0 && (
        <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "0 0 4px", lineHeight: 1.5 }}>
          ✓ Auto-fixed {qc.fixes.length} item{qc.fixes.length === 1 ? "" : "s"}: {qc.fixes.slice(0, 2).join("; ")}{qc.fixes.length > 2 ? `; +${qc.fixes.length - 2} more` : ""}.
        </p>
      )}
      {qc.warnings.length > 0 && (
        <p style={{ fontSize: "11.5px", color: "#B85C00", margin: 0, lineHeight: 1.5 }}>
          ⚠︎ {qc.warnings.length} warning{qc.warnings.length === 1 ? "" : "s"}: {qc.warnings.slice(0, 2).join("; ")}{qc.warnings.length > 2 ? `; +${qc.warnings.length - 2} more` : ""}.
        </p>
      )}
    </div>
  );
}

// PDF / Print: triggers the OS print dialog. On iOS Chrome this opens the
// share sheet → 'Print' or 'Save as PDF'. On desktop it opens the native
// print dialog with PDF option. Zero new dependencies.
// Saved-trips storage. Keeps up to MAX_SAVED most recent trips in localStorage.
// Each entry: { id, name, savedAt (ISO), inputs, result }.
const SAVED_TRIPS_KEY = "trip-optimizer-saved-v2";
const MAX_SAVED = 12;
function loadSavedTrips() {
  try {
    const raw = localStorage.getItem(SAVED_TRIPS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeSavedTrips(arr) {
  try { localStorage.setItem(SAVED_TRIPS_KEY, JSON.stringify(arr.slice(0, MAX_SAVED))); } catch {}
}
function makeTripId() {
  return "trip_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}
function defaultTripName(inputs, result) {
  const dest = result?.destination || inputs?.basics?.destination || "Trip";
  const start = inputs?.basics?.startDate;
  const monthDay = start ? new Date(start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  return monthDay ? `${dest} · ${monthDay}` : dest;
}

// SaveTripButton — prompts for a name, persists trip, calls onSaved with the saved entry.
function SaveTripButton({ inputs, result, onSaved }) {
  const [justSaved, setJustSaved] = useState(false);
  const handleClick = () => {
    const fallback = defaultTripName(inputs, result);
    const name = (typeof window !== "undefined" && window.prompt) ? (window.prompt("Name this trip", fallback) || fallback) : fallback;
    const entry = { id: makeTripId(), name: name.trim() || fallback, savedAt: new Date().toISOString(), inputs, result };
    const existing = loadSavedTrips();
    writeSavedTrips([entry, ...existing]);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2200);
    if (typeof onSaved === "function") onSaved(entry);
  };
  return (
    <button
      onClick={handleClick}
      className="no-print"
      style={{
        background: justSaved ? GOLD : "var(--color-background-primary)",
        color: justSaved ? "#0F0F0F" : "var(--color-text-primary)",
        border: `0.5px solid ${justSaved ? GOLD : "var(--color-border-secondary)"}`,
        borderRadius: "var(--border-radius-md)",
        padding: "10px 16px",
        fontSize: "11px",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "pointer",
        fontFamily: "inherit",
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        transition: "background 200ms ease",
      }}
      aria-label="Save this trip"
    >
      <span aria-hidden="true">{justSaved ? "✓" : "☆"}</span> {justSaved ? "Saved" : "Save trip"}
    </button>
  );
}

// SavedTripsPanel — shown above the form on step 1 when at least one trip exists.
// Each row: name, route summary, savedAt, [Open] [×].
function SavedTripsPanel({ trips, onOpen, onDelete }) {
  if (!trips || trips.length === 0) return null;
  return (
    <div style={{ marginBottom: "1.25rem", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "14px 16px", background: "var(--color-background-primary)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
        <p style={{ fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: 0 }}>Saved trips</p>
        <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: 0 }}>{trips.length} saved</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
        {trips.map((t, i) => {
          const dest = t.result?.destination || t.inputs?.basics?.destination || "—";
          const start = t.inputs?.basics?.startDate;
          const nights = t.inputs?.basics?.nights;
          const meta = [
            start ? new Date(start + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null,
            nights ? `${nights} nights` : null,
          ].filter(Boolean).join(" · ");
          const savedAgo = new Date(t.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderTop: i > 0 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "13.5px", color: "var(--color-text-primary)", margin: "0 0 2px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</p>
                <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: 0 }}>{dest !== t.name ? `${dest} · ` : ""}{meta || `saved ${savedAgo}`}</p>
              </div>
              <button onClick={() => onOpen(t)} style={{ background: "var(--color-text-primary)", color: "var(--color-background-primary)", border: "none", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Open</button>
              <button onClick={() => onDelete(t.id)} aria-label={`Delete ${t.name}`} style={{ background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: "18px", cursor: "pointer", padding: "4px 6px", lineHeight: 1 }}>×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// StaleChipsBanner — warns when the user has chips lingering from a previous
// destination and offers a one-tap clear. Non-blocking; dismissible.
function StaleChipsBanner({ suggestion, onClear, onDismiss }) {
  if (!suggestion) return null;
  const total = (suggestion.staleRestaurants?.length || 0) + (suggestion.staleActivities?.length || 0);
  if (total === 0) return null;
  const items = [
    ...(suggestion.staleRestaurants || []),
    ...(suggestion.staleActivities || []),
  ];
  return (
    <div role="status" style={{ marginBottom: "1.25rem", border: "0.5px solid #B85C00", background: "#FFF7E8", borderRadius: "var(--border-radius-md)", padding: "12px 14px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <span aria-hidden="true" style={{ fontSize: "14px", color: "#B85C00", marginTop: "1px" }}>⚠︎</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: "11px", color: "#7A3D00", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 4px" }}>Destination changed</p>
          <p style={{ fontSize: "13px", color: "#3D2400", margin: "0 0 8px", lineHeight: 1.5 }}>
            {total} pick{total === 1 ? "" : "s"} from {suggestion.prevLabel} {total === 1 ? "is" : "are"} still selected for {suggestion.newLabel || "your new destination"}.
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
            {items.map((it, i) => (
              <span key={i} style={{ fontSize: "11px", background: "#FFE9C4", border: "0.5px solid #E5B870", color: "#5C3A00", borderRadius: "3px", padding: "3px 7px" }}>{it}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button onClick={onClear} style={{ background: "#B85C00", color: "#FFF", border: "none", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Clear those picks</button>
            <button onClick={onDismiss} style={{ background: "transparent", color: "#7A3D00", border: "0.5px solid #B85C00", borderRadius: "var(--border-radius-md)", padding: "7px 12px", fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Keep them</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Build a clean filename from trip basics: "trip-YYYY-MM-DD-destination-Nn.pdf".
function pdfFilename(data) {
  const dest = (data?.destination || (Array.isArray(data?.cities) && data.cities[0]?.name) || "trip").toString();
  const slug = dest.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trip";
  const date = (data?.start_date || data?.startDate || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  const n = data?.nights ? `-${data.nights}n` : "";
  return `trip-${date}-${slug}${n}.pdf`;
}

// Render the itinerary DOM to a multi-page PDF using html2canvas-pro + jsPDF.
// This works on iOS Chrome where window.print() is unreliable.
async function saveItineraryAsPDF(filename, setStatus) {
  const root = document.getElementById("trip-print-root");
  if (!root) throw new Error("Itinerary container not found");

  setStatus("Preparing…");
  // Reveal the print-only input summary, hide no-print controls during capture.
  const printOnly = Array.from(root.querySelectorAll(".print-only"));
  const noPrint = Array.from(root.querySelectorAll(".no-print"));
  const prevPrintOnly = printOnly.map(el => el.style.display);
  const prevNoPrint = noPrint.map(el => el.style.display);
  printOnly.forEach(el => { el.style.display = "block"; });
  noPrint.forEach(el => { el.style.display = "none"; });
  const prevBg = root.style.background;
  root.style.background = "#ffffff";

  try {
    const [{ default: html2canvas }, jsPDFModule] = await Promise.all([
      import("html2canvas-pro"),
      import("jspdf"),
    ]);
    const { jsPDF } = jsPDFModule;

    setStatus("Rendering…");
    const canvas = await html2canvas(root, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      windowWidth: Math.max(root.scrollWidth, 800),
    });

    setStatus("Building PDF…");
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;

    const imgW = usableW;
    const imgH = (canvas.height * imgW) / canvas.width;

    if (imgH <= usableH) {
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, imgW, imgH, undefined, "FAST");
    } else {
      const pxPerMm = canvas.width / imgW;
      const pageSliceHpx = Math.floor(usableH * pxPerMm);
      let yPx = 0;
      let pageIndex = 0;
      while (yPx < canvas.height) {
        const sliceHpx = Math.min(pageSliceHpx, canvas.height - yPx);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = sliceHpx;
        const ctx = slice.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, yPx, canvas.width, sliceHpx, 0, 0, canvas.width, sliceHpx);
        const sliceImgH = sliceHpx / pxPerMm;
        if (pageIndex > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL("image/jpeg", 0.9), "JPEG", margin, margin, imgW, sliceImgH, undefined, "FAST");
        yPx += sliceHpx;
        pageIndex++;
      }
    }

    setStatus("Saving…");
    pdf.save(filename);
  } finally {
    printOnly.forEach((el, i) => { el.style.display = prevPrintOnly[i]; });
    noPrint.forEach((el, i) => { el.style.display = prevNoPrint[i]; });
    root.style.background = prevBg;
  }
}

function PrintButton({ data }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const handleClick = async () => {
    if (busy) return;
    setBusy(true); setError(""); setStatus("Starting…");
    try {
      await saveItineraryAsPDF(pdfFilename(data), setStatus);
    } catch (err) {
      console.error("PDF save failed", err);
      setError("Could not save PDF. Try again.");
    } finally {
      setBusy(false);
      setStatus("");
      setTimeout(() => setError(""), 5000);
    }
  };

  return (
    <div className="no-print" style={{ display: "inline-flex", flexDirection: "column", gap: "4px" }}>
      <button
        onClick={handleClick}
        disabled={busy}
        style={{
          background: "var(--color-text-primary)",
          color: "var(--color-background-primary)",
          border: "none",
          borderRadius: "var(--border-radius-md)",
          padding: "10px 16px",
          fontSize: "11px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          cursor: busy ? "wait" : "pointer",
          fontFamily: "inherit",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          opacity: busy ? 0.7 : 1,
        }}
        aria-label="Save itinerary as PDF"
      >
        <span aria-hidden="true">⤓</span> {busy ? (status || "Working…") : "Save as PDF"}
      </button>
      {error && (
        <span style={{ fontSize: "11px", color: "#B85C00" }}>{error}</span>
      )}
    </div>
  );
}

// Input summary — shown ONLY in print output. Recaps the form inputs that
// produced this plan so the printed PDF is a complete record of inputs+output.
function InputSummary({ inputs }) {
  if (!inputs) return null;
  const { basics, flights, hotel, transport, dining, restaurants, activities, interests, outputs } = inputs;
  const citiesText = Array.isArray(basics?.cities) && basics.cities.length > 1
    ? basics.cities.map((c, i) => `${i + 1}) ${c.name} — ${c.nights} ${Number(c.nights) === 1 ? "night" : "nights"}${c.focus ? ` (${c.focus})` : ""}`).join("   ")
    : null;
  const rows = [
    ["Destination", basics?.destination],
    ...(citiesText ? [["Route", citiesText]] : []),
    ["Base area", basics?.baseArea || "—"],
    ["Start date", basics?.startDate],
    ["Nights", basics?.nights],
    ["Travelers", basics?.travelers],
    ["Style", basics?.style],
    ["Pace", basics?.pace],
    ["Budget", basics?.budget],
    ["Home airport", flights?.homeAirport],
    ["Preferred airline", flights?.airline || "—"],
    ["Cabin", flights?.cabin || "—"],
    ["Date flex", flights?.flex || "—"],
    ["Hotel brand", hotel?.brand || "—"],
    ["Hotel tier", hotel?.tier || "—"],
    ["Hotel must-have", hotel?.mustHave || "—"],
    ["Transport", transport?.type + (transport?.company ? ` · ${transport.company}` : "")],
    ["Vehicle", transport?.vehicle || "—"],
    ["Cuisine focus", dining?.cuisine || "—"],
    ["Dinner budget", Array.isArray(dining?.budget) ? (dining.budget.length ? dining.budget.join(", ") : "—") : (dining?.budget || "—")],
    ["Requested restaurants", (restaurants && restaurants.length) ? restaurants.join(", ") : "—"],
    ["Requested activities", (activities && activities.length) ? activities.join(", ") : "—"],
    ["Interest level", interests?.level || "—"],
    ["Interest detail", interests?.text || "—"],
    ["Sections requested", outputs ? Object.entries(outputs).filter(([, v]) => v).map(([k]) => k).join(", ") : "—"],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");

  return (
    <div className="print-only" style={{ display: "none" }}>
      <h2 style={{ fontSize: "14px", letterSpacing: "0.08em", textTransform: "uppercase", color: "#000", margin: "0 0 10px", borderBottom: "1px solid #ccc", paddingBottom: "6px" }}>Input summary</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10.5px", marginBottom: "16px" }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: "0.5px solid #eee" }}>
              <td style={{ padding: "4px 8px 4px 0", color: "#666", verticalAlign: "top", width: "38%", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "9px", fontWeight: 600 }}>{k}</td>
              <td style={{ padding: "4px 0", color: "#000" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "9px", color: "#888", margin: "0 0 20px", fontStyle: "italic" }}>Generated {new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · trip-optimizer-6og.pages.dev</p>
    </div>
  );
}

function TripHero({ data }) {
  // Pull flight + hotel summary directly from days[].
  const items = (data.days || []).flatMap(d => (d.items || []));
  const flights = items.filter(it => it.type === "Flight" && it.flight);
  const outbound = flights[0]?.flight;
  const inbound = flights[flights.length - 1]?.flight;
  const hotelItem = items.find(it => it.type === "Hotel" && it.hotel)?.hotel;
  const mealCount = items.filter(it => /^(Breakfast|Brunch|Lunch|Dinner|Dining)$/i.test(it.type || "")).length;
  const activityCount = items.filter(it => it.type === "Activity").length;

  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <p style={{ fontSize: "11px", color: GOLD, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: "600", margin: "0 0 6px" }}>Your trip</p>
      <p style={{ fontSize: "24px", fontWeight: "400", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: "0 0 4px", color: "var(--color-text-primary)", letterSpacing: "-0.4px", lineHeight: 1.15 }}>{data.destination}</p>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{data.meta}</p>

      {(outbound || hotelItem || mealCount > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "8px", marginBottom: "14px", padding: "12px 14px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary)" }}>
          {outbound && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Fly out</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{outbound.carrier} {outbound.flight_number} · {outbound.from_airport}→{outbound.to_airport} · {formatTime(outbound.depart_time)}</span>
            </div>
          )}
          {inbound && inbound !== outbound && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Return</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{inbound.carrier} {inbound.flight_number} · {inbound.from_airport}→{inbound.to_airport} · {formatTime(inbound.depart_time)}</span>
            </div>
          )}
          {hotelItem && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Stay</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{hotelItem.name}</span>
            </div>
          )}
          {(mealCount > 0 || activityCount > 0) && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" }}>
              <span style={{ color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "10px", fontWeight: 600, minWidth: "60px" }}>Plan</span>
              <span style={{ color: "var(--color-text-primary)", textAlign: "right", flex: 1 }}>{mealCount} meals · {activityCount} activities · {(data.days || []).length} days</span>
            </div>
          )}
        </div>
      )}

      {Array.isArray(data.cities) && data.cities.length > 1 && (
        <div style={{ marginBottom: "14px", padding: "12px 14px", border: `1px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", background: "var(--color-background-primary)" }}>
          <p style={{ fontSize: "10px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 8px" }}>Trip route · {data.cities.length} cities</p>
          {data.cities.map((c, i) => (
            <div key={i} style={{ borderTop: i > 0 ? "0.5px solid var(--color-border-tertiary)" : "none", paddingTop: i > 0 ? "8px" : 0, marginTop: i > 0 ? "8px" : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "baseline" }}>
                <span style={{ fontSize: "13.5px", color: "var(--color-text-primary)", fontWeight: 500 }}>
                  <span style={{ color: GOLD, fontWeight: 700, marginRight: "6px" }}>{i + 1}.</span>{c.name}
                </span>
                <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{c.nights} {Number(c.nights) === 1 ? "night" : "nights"}{c.days_range ? ` · ${c.days_range}` : ""}</span>
              </div>
              {c.transport_in && (
                <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "3px 0 0", lineHeight: 1.5 }}>→ {c.transport_in}</p>
              )}
              {c.focus && (
                <p style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", margin: "3px 0 0", lineHeight: 1.5, fontStyle: "italic" }}>{c.focus}</p>
              )}
              {c.stay && (
                <p style={{ fontSize: "11px", color: "var(--color-text-tertiary)", margin: "3px 0 0" }}>Stay: {c.stay}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {Array.isArray(data.logistics) && data.logistics.length > 0 && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {data.logistics.map((l, i) => (
            <span key={i} style={{ fontSize: "11.5px", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "4px 9px", color: "var(--color-text-secondary)" }}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function DayNav({ days }) {
  if (!days || days.length < 2) return null;
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 5, background: "var(--color-background-primary)", paddingTop: "6px", paddingBottom: "8px", marginBottom: "10px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ display: "flex", gap: "6px", overflowX: "auto", scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
        {days.map((d, i) => {
          const parts = (d.label || "").split(" · ");
          const short = parts[1] || `Day ${i + 1}`;
          return (
            <a key={i} href={`#day-${i + 1}`} style={{ flex: "0 0 auto", fontSize: "10.5px", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600, color: "var(--color-text-secondary)", padding: "5px 9px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "3px", textDecoration: "none", whiteSpace: "nowrap", background: "var(--color-background-primary)" }}>{i + 1} · {short}</a>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// ReviewPanel — the post-build Professional Review surface.
// ----------------------------------------------------------------------------
// Lives at the top of ItineraryView. Three states:
//   (1) idle    — show the banner card with reviewer picker + 'Run review'
//   (2) running — show the progress bar (~45s target for review, ~2min for re-plan)
//   (3) done    — show the verdict + findings cards, each with per-finding Apply
//                 toggle, then a single bottom Apply button.
//
// All result/state writes go up through onPlanRevised / onReviewChange so the
// parent (TripOptimizer) can persist them into saved trips.
// ============================================================================
function ReviewPanel({ plan, inputs, onPlanRevised, onReviewChange, initialReview }) {
  // --- review state ------------------------------------------------------
  // 'idle' — banner card with picker
  // 'running' — review in flight
  // 'done' — review back, findings visible
  // 'applying' — revision in flight
  // 'applied' — revision back, brief success state before fading back to done
  const [status, setStatus] = useState(initialReview ? "done" : "idle");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => {
    if (initialReview?.sources) return initialReview.sources;
    return REVIEWER_SOURCES.filter(s => s.dflt).map(s => s.id);
  });
  const [review, setReview] = useState(initialReview?.review || null);
  const [applyState, setApplyState] = useState({}); // findingId -> bool
  const [appliedIds, setAppliedIds] = useState(() => initialReview?.applied_ids || []);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef(null);

  // Initialize per-finding Apply toggles from default_apply when review arrives.
  useEffect(() => {
    if (review && Array.isArray(review.findings)) {
      setApplyState(prev => {
        // Preserve any explicit user choices; default the rest from default_apply.
        const next = { ...prev };
        for (const f of review.findings) {
          if (!(f.id in next)) next[f.id] = !!f.default_apply;
        }
        return next;
      });
    }
  }, [review]);

  const selectedSources = REVIEWER_SOURCES.filter(s => selectedIds.includes(s.id));
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const selectedForApply = findings.filter(f => applyState[f.id]);
  const revisionMode = routeRevisionMode(selectedForApply);
  const criticalCount = findings.filter(f => f.severity === "critical").length;
  const suggestedCount = findings.filter(f => f.severity === "suggested").length;
  const niceCount = findings.filter(f => f.severity === "nice").length;

  // ----- handlers --------------------------------------------------------
  const handleRunReview = async () => {
    if (selectedSources.length === 0) { setError("Pick at least one source."); return; }
    setStatus("running");
    setError("");
    setProgress(0);
    setProgressLabel("Starting review…");
    setElapsedSec(0);
    const startedAt = Date.now();
    const targetSec = 45;
    let lastTokFrac = 0;

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      setProgress(prev => Math.max(prev, Math.max(lastTokFrac, timeFrac)));
    }, 250);

    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeout = setTimeout(() => controller.abort(), 300000);

    try {
      const body = {
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        system: buildReviewSystemPrompt(plan, selectedSources, inputs),
        messages: [{ role: "user", content: buildReviewUserPrompt() }],
        tools: [REVIEW_TOOL],
        tool_choice: { type: "tool", name: "submit_review" },
      };
      const jobId = await startBuildJob(body);
      let toolJson = "";
      await pollBuildJob({
        jobId,
        signal: controller.signal,
        onDelta: (delta) => {
          toolJson += delta;
          const estTokens = toolJson.length / 3.5;
          const tokFrac = Math.min(0.95, estTokens / 1800);
          lastTokFrac = tokFrac;
          setProgress(prev => Math.max(prev, tokFrac));
          const fMatches = toolJson.match(/"summary"\s*:\s*"/g) || [];
          if (toolJson.length < 200) setProgressLabel("Reading the plan…");
          else if (fMatches.length === 0) setProgressLabel("Forming verdict…");
          else setProgressLabel(`Drafting findings (${fMatches.length})`);
        },
      });
      setProgress(1);
      setProgressLabel("Finalizing…");
      const { parsed } = parseToolJson(toolJson);
      if (!parsed || !Array.isArray(parsed.findings)) throw new Error("Review returned no findings.");
      setReview(parsed);
      // Reset per-finding toggles to defaults on a fresh review.
      const fresh = {};
      parsed.findings.forEach(f => { fresh[f.id] = !!f.default_apply; });
      setApplyState(fresh);
      setAppliedIds([]);
      setStatus("done");
      if (typeof onReviewChange === "function") {
        onReviewChange({
          sources: selectedIds,
          review: parsed,
          applied_ids: [],
          generatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        setError("Review cancelled.");
      } else {
        setError(err?.message || "Review failed.");
      }
      setStatus("idle");
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  const handleCancelReview = () => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
  };

  const handleApply = async () => {
    if (selectedForApply.length === 0) { setError("Pick at least one change to apply."); return; }
    setStatus("applying");
    setError("");
    setProgress(0);
    setProgressLabel(revisionMode === "surgical" ? "Applying patches…" : "Re-planning the trip…");
    setElapsedSec(0);
    const startedAt = Date.now();
    const targetSec = revisionMode === "surgical" ? 35 : 160;
    let lastTokFrac = 0;

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      setProgress(prev => Math.max(prev, Math.max(lastTokFrac, timeFrac)));
    }, 250);

    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeout = setTimeout(() => controller.abort(), 300000);

    try {
      const body = revisionMode === "surgical"
        ? {
            model: "claude-sonnet-4-5",
            max_tokens: 8000,
            system: buildRevisionSystemPromptSurgical(plan, selectedForApply, inputs),
            messages: [{ role: "user", content: buildRevisionUserPromptSurgical() }],
            tools: [REVISION_TOOL_SURGICAL],
            tool_choice: { type: "tool", name: "submit_revision_patches" },
          }
        : {
            model: "claude-sonnet-4-5",
            max_tokens: 32000,
            system: buildRevisionSystemPromptFull(plan, selectedForApply, inputs),
            messages: [{ role: "user", content: buildRevisionUserPromptFull() }],
            tools: [REVISION_TOOL_FULL],
            tool_choice: { type: "tool", name: "submit_trip_plan" },
          };
      const jobId = await startBuildJob(body);
      let toolJson = "";
      await pollBuildJob({
        jobId,
        signal: controller.signal,
        onDelta: (delta) => {
          toolJson += delta;
          const estTokens = toolJson.length / 3.5;
          const tokFrac = Math.min(0.95, estTokens / (revisionMode === "surgical" ? 1500 : 7000));
          lastTokFrac = tokFrac;
          setProgress(prev => Math.max(prev, tokFrac));
          if (revisionMode === "surgical") {
            const pm = toolJson.match(/"op"\s*:/g) || [];
            setProgressLabel(pm.length ? `Applying patch ${pm.length}…` : "Reading plan…");
          } else {
            const dm = toolJson.match(/"label"\s*:\s*"/g) || [];
            setProgressLabel(dm.length ? `Day ${dm.length} of plan…` : "Re-planning…");
          }
        },
      });
      setProgress(1);
      setProgressLabel("Finalizing…");
      const { parsed } = parseToolJson(toolJson);
      let newPlan;
      if (revisionMode === "surgical") {
        if (!parsed || !Array.isArray(parsed.patches)) throw new Error("Revision returned no patches.");
        newPlan = applyPatchesToPlan(plan, parsed.patches);
      } else {
        if (!parsed || !Array.isArray(parsed.days) || parsed.days.length === 0) throw new Error("Revision returned no plan.");
        newPlan = parsed;
      }
      const newAppliedIds = Array.from(new Set([...appliedIds, ...selectedForApply.map(f => f.id)]));
      setAppliedIds(newAppliedIds);
      // Clear the apply toggles for findings we just applied so the same
      // ones don't sit checked indefinitely.
      setApplyState(prev => {
        const next = { ...prev };
        for (const f of selectedForApply) next[f.id] = false;
        return next;
      });
      setStatus("applied");
      setTimeout(() => setStatus("done"), 2500);
      if (typeof onPlanRevised === "function") {
        onPlanRevised(newPlan);
      }
      if (typeof onReviewChange === "function") {
        onReviewChange({
          sources: selectedIds,
          review,
          applied_ids: newAppliedIds,
          generatedAt: new Date().toISOString(),
          last_mode: revisionMode,
        });
      }
    } catch (err) {
      if (err?.name === "AbortError") setError("Apply cancelled.");
      else setError(err?.message || "Apply failed.");
      setStatus("done");
    } finally {
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      abortRef.current = null;
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  const togglePickerSource = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleFindingApply = (fid) => {
    setApplyState(prev => ({ ...prev, [fid]: !prev[fid] }));
  };

  // ----- shared styles ---------------------------------------------------
  const cardStyleLocal = { border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "14px 16px", marginBottom: "1.25rem", background: "var(--color-background-primary)" };
  const sectionLabel = { fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 6px" };

  // ----- render ----------------------------------------------------------
  return (
    <div className="no-print">
      {/* PICKER MODAL */}
      {pickerOpen && (
        <ReviewPickerModal
          selectedIds={selectedIds}
          onToggle={togglePickerSource}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* IDLE — banner with picker + Run */}
      {status === "idle" && (
        <div style={cardStyleLocal}>
          <p style={sectionLabel}>Professional review</p>
          <p style={{ fontSize: "14px", color: "var(--color-text-primary)", margin: "0 0 4px", fontFamily: "var(--font-serif)", fontStyle: "italic" }}>
            Have your plan reviewed by a panel of luxury-travel experts.
          </p>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px", lineHeight: 1.55 }}>
            They&rsquo;ll flag what to fix, what to upgrade, and what to skip. You pick which changes to apply.
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
            {selectedSources.map(s => (
              <span key={s.id} style={{ fontSize: "10.5px", color: "#0F0F0F", background: GOLD, padding: "3px 9px", borderRadius: "999px", letterSpacing: "0.02em", fontWeight: 600, whiteSpace: "nowrap" }}>{s.name}</span>
            ))}
            <button onClick={() => setPickerOpen(true)} style={{ fontSize: "10.5px", color: GOLD, background: "transparent", border: `0.5px dashed ${GOLD}`, padding: "3px 9px", borderRadius: "999px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em", fontWeight: 600 }}>+ Change sources</button>
          </div>
          <p style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: "0 0 12px", fontStyle: "italic" }}>
            Why these? They cover taste (CN Traveler), food (Michelin), pacing (NYT 36 Hours), and ground-truth (Reddit + locals). Add more for hotel-specific or scene-specific feedback.
          </p>
          <button onClick={handleRunReview} style={{ width: "100%", border: "none", borderRadius: "var(--border-radius-md)", padding: "12px 18px", fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "#0F0F0F", color: GOLD }}>
            Run review (~45 sec)
          </button>
          {error && <p style={{ fontSize: "11.5px", color: "#c0392b", margin: "8px 0 0", textAlign: "center" }}>{error}</p>}
        </div>
      )}

      {/* RUNNING (review) or APPLYING (revision) */}
      {(status === "running" || status === "applying") && (
        <div style={cardStyleLocal}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "8px", gap: "10px" }}>
            <p style={{ ...sectionLabel, margin: 0 }}>{status === "running" ? "Review in progress" : revisionMode === "surgical" ? "Applying quick edits" : "Re-planning trip"}</p>
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: 0, fontVariantNumeric: "tabular-nums" }}>
              {progress > 0 ? `${Math.round(progress * 100)}%` : ""}{elapsedSec > 0 ? `  ·  ${Math.floor(elapsedSec/60)}:${String(elapsedSec%60).padStart(2,'0')}` : ""}
            </p>
          </div>
          <p style={{ fontSize: "12.5px", color: "var(--color-text-primary)", margin: "0 0 8px" }}>{progressLabel || "Working…"}</p>
          <div style={{ height: "5px", borderRadius: "3px", background: "var(--color-border-tertiary, #eee)", overflow: "hidden", position: "relative" }}>
            {progress > 0 ? (
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`, background: GOLD, transition: "width 0.3s ease-out", borderRadius: "3px" }} />
            ) : (
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: GOLD, animation: "slideBar 1.6s ease-in-out infinite" }} />
            )}
          </div>
          <button onClick={handleCancelReview} style={{ marginTop: "10px", width: "100%", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "9px 16px", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "transparent", color: "var(--color-text-primary)" }}>
            Cancel
          </button>
        </div>
      )}

      {/* DONE — verdict + findings */}
      {(status === "done" || status === "applied") && review && (
        <div style={cardStyleLocal}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px", marginBottom: "8px" }}>
            <p style={{ ...sectionLabel, margin: 0 }}>Review by {selectedSources.length} source{selectedSources.length !== 1 ? "s" : ""}</p>
            <button onClick={() => { setStatus("idle"); setReview(null); }} style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
              Re-run review
            </button>
          </div>
          <p style={{ fontSize: "15px", color: "var(--color-text-primary)", margin: "0 0 10px", lineHeight: 1.5, fontFamily: "var(--font-serif)", fontStyle: "italic" }}>{review.verdict}</p>
          {findings.length > 0 && (
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
              {criticalCount > 0 && <span style={{ color: "#c0392b", fontWeight: 600 }}>{criticalCount} critical</span>}
              {criticalCount > 0 && (suggestedCount + niceCount) > 0 && <span>  ·  </span>}
              {suggestedCount > 0 && <span>{suggestedCount} suggested</span>}
              {suggestedCount > 0 && niceCount > 0 && <span>  ·  </span>}
              {niceCount > 0 && <span style={{ color: "var(--color-text-tertiary)" }}>{niceCount} nice</span>}
            </p>
          )}
          {findings.length === 0 && (
            <p style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", margin: "0 0 4px", fontStyle: "italic" }}>
              No notes — the panel signed off as-is.
            </p>
          )}
          {findings.map(f => (
            <FindingCard
              key={f.id}
              finding={f}
              checked={!!applyState[f.id]}
              alreadyApplied={appliedIds.includes(f.id)}
              onToggle={() => toggleFindingApply(f.id)}
            />
          ))}

          {/* Bottom Apply button — only when something is checked */}
          {selectedForApply.length > 0 && (
            <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
              <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 8px" }}>
                {selectedForApply.length} change{selectedForApply.length === 1 ? "" : "s"} selected ·&nbsp;
                <span style={{ color: GOLD, fontWeight: 600 }}>
                  {revisionMode === "surgical" ? "Quick edit — ~30 sec" : "Full re-plan — ~2 min"}
                </span>
              </p>
              <button onClick={handleApply} style={{ width: "100%", border: "none", borderRadius: "var(--border-radius-md)", padding: "12px 18px", fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", background: "#0F0F0F", color: GOLD }}>
                {revisionMode === "surgical" ? "Apply quick edits" : "Apply — full re-plan"}
              </button>
            </div>
          )}
          {status === "applied" && (
            <p style={{ marginTop: "10px", fontSize: "12px", color: GOLD, textAlign: "center", fontWeight: 600 }}>✓ Changes applied to your plan.</p>
          )}
          {error && <p style={{ fontSize: "11.5px", color: "#c0392b", margin: "8px 0 0", textAlign: "center" }}>{error}</p>}
        </div>
      )}
    </div>
  );
}

// Picker modal — bottom-sheet style on mobile. Multi-select gold chips,
// grouped by lens. Tap a chip to toggle. Tap Done to close.
function ReviewPickerModal({ selectedIds, onToggle, onClose }) {
  const lensOrder = ["editorial", "hotels", "restaurants", "local"];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,15,15,0.6)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: "640px", maxHeight: "85vh", overflowY: "auto", background: "var(--color-background-primary, #fff)", borderTopLeftRadius: "16px", borderTopRightRadius: "16px", padding: "1.25rem 1.25rem 1.5rem", boxShadow: "0 -10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "1rem" }}>
          <p style={{ fontSize: "15px", fontFamily: "var(--font-serif)", fontStyle: "italic", margin: 0, color: "var(--color-text-primary)" }}>Reviewer panel</p>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: GOLD, fontSize: "11px", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" }}>Done</button>
        </div>
        {lensOrder.map(lensId => {
          const lens = REVIEWER_LENSES.find(l => l.id === lensId);
          const sources = REVIEWER_SOURCES.filter(s => s.lens === lensId);
          return (
            <div key={lensId} style={{ marginBottom: "1.1rem" }}>
              <p style={{ fontSize: "10.5px", color: GOLD, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, margin: "0 0 3px" }}>{lens.label}</p>
              <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 8px", fontStyle: "italic", lineHeight: 1.5 }}>{lens.why}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {sources.map(s => {
                  const on = selectedIds.includes(s.id);
                  return (
                    <button key={s.id} onClick={() => onToggle(s.id)} style={{ fontSize: "11.5px", color: on ? "#0F0F0F" : GOLD, background: on ? GOLD : "transparent", border: `0.5px solid ${GOLD}`, padding: "6px 12px", borderRadius: "999px", cursor: "pointer", fontFamily: "inherit", fontWeight: on ? 600 : 500, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
                      {on ? "✓ " : ""}{s.name}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
                {sources.map(s => (
                  <p key={s.id + "_blurb"} style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", margin: 0, fontStyle: "italic" }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>{s.name}</span> — {s.blurb}
                  </p>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Findings card — severity dot, target chip, source chip, summary, action, apply toggle.
function FindingCard({ finding, checked, alreadyApplied, onToggle }) {
  const sev = finding.severity || "suggested";
  const sevColor = sev === "critical" ? "#c0392b" : sev === "suggested" ? GOLD : "#7a7a7a";
  const sevLabel = sev === "critical" ? "Critical" : sev === "suggested" ? "Suggested" : "Nice";
  return (
    <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", padding: "12px 0 4px", opacity: alreadyApplied ? 0.55 : 1 }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <span style={{ flex: "0 0 auto", marginTop: "5px", width: "8px", height: "8px", borderRadius: "50%", background: sevColor }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "4px", alignItems: "baseline" }}>
            <span style={{ fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: sevColor, padding: "2px 6px", border: `0.5px solid ${sevColor}`, borderRadius: "3px" }}>{sevLabel}</span>
            {finding.target && <span style={{ fontSize: "10.5px", color: "var(--color-text-primary)", background: "var(--color-background-secondary, #fafafa)", padding: "2px 7px", borderRadius: "3px", border: "0.5px solid var(--color-border-tertiary)" }}>{formatFindingTarget(finding.target)}</span>}
            {finding.source && <span style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>via {finding.source}</span>}
          </div>
          <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 4px", lineHeight: 1.5 }}>{finding.summary}</p>
          {finding.action && <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.5 }}><span style={{ color: GOLD, fontWeight: 600, marginRight: "4px" }}>→</span>{finding.action}</p>}
          <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", fontSize: "11px", color: "var(--color-text-secondary)", cursor: alreadyApplied ? "default" : "pointer", fontFamily: "inherit" }}>
            <input type="checkbox" checked={checked} onChange={onToggle} disabled={alreadyApplied} style={{ accentColor: GOLD, margin: 0, cursor: alreadyApplied ? "default" : "pointer" }} />
            <span>{alreadyApplied ? "Already applied" : "Apply this change"}</span>
          </label>
        </div>
      </div>
    </div>
  );
}

function ItineraryView({ data: rawData, inputs, onBack, onEditTrip, onSaved, savedTripId, onPlanRevised, onReviewChange, initialReview }) {
  const [menuRestaurant, setMenuRestaurant] = useState(null);
  // Apply the pass-three quality layer once before render. This dedupes
  // restaurants, fills verify microcopy, and computes a QC summary.
  const { data, qc } = useMemo(() => applyQualityLayer(rawData, inputs), [rawData, inputs]);
  const sortedTonight = Array.isArray(data.tonight)
    ? [...data.tonight].map((t, i) => ({ t, i, p: tonightPriority(t) })).sort((a, b) => a.p.rank - b.p.rank || a.i - b.i)
    : [];
  // Multi-city: track which day starts a new leg so we can render a divider.
  const cityByDay = (data.days || []).map(d => d.city || null);
  const isMultiCityPlan = Array.isArray(data.cities) && data.cities.length > 1;
  return (
    <div id="trip-print-root">
      <InputSummary inputs={inputs} />
      <MenuModal restaurant={menuRestaurant} onClose={() => setMenuRestaurant(null)} />
      <TripHero data={data} />
      <QualityBadge qc={qc} />

      {/* Professional review surface — user-initiated, sits between hero and the day-by-day content. */}
      <ReviewPanel
        plan={rawData}
        inputs={inputs}
        onPlanRevised={onPlanRevised}
        onReviewChange={onReviewChange}
        initialReview={initialReview}
      />

      {/* Pre-day high-signal block: do this tonight first, weather/pack second */}
      {sortedTonight.length > 0 && (
        <Section title="Do this tonight">
          <div style={{ borderRadius: "var(--border-radius-md)", overflow: "hidden", border: "0.5px solid var(--color-border-secondary)" }}>
            {sortedTonight.map(({ t, p }, i) => {
              const text = stripTonightPrefix(t);
              return (
                <div key={i} style={{ display: "flex", gap: "10px", padding: "10px 12px", borderTop: i > 0 ? "0.5px solid var(--color-border-tertiary)" : "none", background: p.bg, alignItems: "flex-start" }}>
                  {p.label && (
                    <span style={{ flex: "0 0 auto", fontSize: "9.5px", fontWeight: 700, color: p.color, letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", border: `0.5px solid ${p.color}`, borderRadius: "3px", whiteSpace: "nowrap", marginTop: "1px" }}>{p.label}</span>
                  )}
                  <span style={{ fontSize: "12.5px", color: "var(--color-text-primary)", lineHeight: 1.5, flex: 1 }}>{text}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {(data.weather_window || (Array.isArray(data.pack) && data.pack.length > 0)) && (
        <Section title="Weather & pack">
          {data.weather_window && (
            <p style={{ fontSize: "13px", color: "var(--color-text-primary)", margin: "0 0 12px", lineHeight: 1.55 }}>☀ {data.weather_window}</p>
          )}
          {Array.isArray(data.pack) && data.pack.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "4px" }}>
              {data.pack.map((p, i) => (
                <div key={i} style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", display: "flex", gap: "8px", lineHeight: 1.5 }}>
                  <span style={{ color: GOLD, flex: "0 0 auto" }}>✓</span><span>{p}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {data.days && data.days.length > 0 && (
        <Section title="Day-by-day">
          <DayNav days={data.days} />
          {data.days.map((d, i) => {
            const prevCity = i > 0 ? cityByDay[i - 1] : null;
            const showLegHeader = isMultiCityPlan && d.city && d.city !== prevCity;
            const legIndex = showLegHeader ? (cityByDay.slice(0, i + 1).filter((c, k, arr) => c && c !== arr[k - 1]).length) : null;
            return (
              <div key={i}>
                {showLegHeader && (
                  <div style={{ margin: "0 0 14px", padding: "10px 12px", background: "#0F0F0F", color: "#FFFFFF", borderRadius: "var(--border-radius-md)", display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700, color: GOLD }}>Leg {legIndex}</span>
                    <span style={{ fontSize: "15px", fontFamily: "var(--font-serif)", fontStyle: "italic", letterSpacing: "-0.2px" }}>{d.city}</span>
                  </div>
                )}
                <DayBlock day={d} dayIndex={i} onOpenMenu={setMenuRestaurant} />
              </div>
            );
          })}
        </Section>
      )}

      {data.flags && data.flags.length > 0 && (
        <Section title="Heads up">
          {data.flags.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "6px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.5 }}>
              <span style={{ flex: "0 0 auto", color: "#B85C00", fontSize: "12px", marginTop: "1px" }}>⚠︎</span>
              <span>{f}</span>
            </div>
          ))}
        </Section>
      )}

      {data.planb && data.planb.length > 0 && (
        <Section title="If plans break">
          {data.planb.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "7px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.5 }}>
              <span style={{ flex: "0 0 auto", fontSize: "9.5px", fontWeight: 700, color: "#5B6E8F", letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 7px", border: "0.5px solid #5B6E8F", borderRadius: "3px", whiteSpace: "nowrap", marginTop: "1px" }}>Plan B</span>
              <span>{p}</span>
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

      <div className="no-print" style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "0.5rem" }}>
        {onEditTrip && (
          <button
            onClick={onEditTrip}
            style={{ background: "transparent", border: `0.5px solid ${GOLD}`, borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", color: GOLD, fontWeight: 500 }}
            title="Go back to the input form with this trip's details still filled in — tweak dates, cities, or anything else and rebuild."
          >✎ Edit trip details</button>
        )}
        <button
          onClick={onBack}
          style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", color: "var(--color-text-secondary)" }}
        >← Plan another trip</button>
        <SaveTripButton inputs={inputs} result={rawData} onSaved={onSaved} />
        <PrintButton data={data} />
      </div>
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
function Autocomplete({ value, onChange, placeholder, getSuggestions, renderItem, itemToValue, itemKey, openOnFocusEmpty = false, minChars = 1, loading = false, emptyHint = null }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef(null);

  const q = (value ?? "").toString().trim().toLowerCase();
  const showList = (q.length >= minChars || (openOnFocusEmpty && q.length === 0));
  const suggestions = showList ? getSuggestions(q).slice(0, 8) : [];
  const showPanel = open && (suggestions.length > 0 || (showList && (loading || emptyHint)));

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
      {showPanel && (
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
          {loading && (
            <div className="city-suggestion" style={{ opacity: 0.65, fontStyle: "italic", cursor: "default", pointerEvents: "none" }}>
              Searching worldwide…
            </div>
          )}
          {!loading && suggestions.length === 0 && emptyHint && (
            <div className="city-suggestion" style={{ opacity: 0.65, fontStyle: "italic", cursor: "default", pointerEvents: "none" }}>
              {emptyHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// US state name -> USPS code, for compact display of Nominatim results.
const US_STATE_ABBR = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL",
  "indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
  "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
  "puerto rico":"PR"
};

// In-memory cache of Nominatim queries (per page load).
const NOMINATIM_CACHE = new Map();

// Acceptable place types -- skips countries, regions, roads, POIs.
const CITY_TYPES = new Set(["city","town","village","hamlet","municipality","suburb","borough","neighbourhood","locality"]);

function formatNominatim(r) {
  const a = r.address || {};
  const place = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.borough || a.locality || (r.name || "").split(",")[0].trim();
  if (!place) return null;
  const cc = (a.country_code || "").toLowerCase();
  if (cc === "us") {
    const stateName = (a.state || "").toLowerCase();
    const abbr = US_STATE_ABBR[stateName] || (a.state || "");
    if (!abbr) return null;
    return { name: `${place}, ${abbr}`, country: "USA", _src: "world" };
  }
  return { name: place, country: a.country || "", _src: "world" };
}

async function geocodeNominatim(q, signal) {
  const key = q.trim().toLowerCase();
  if (!key) return [];
  if (NOMINATIM_CACHE.has(key)) return NOMINATIM_CACHE.get(key);
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&accept-language=en`;
  const res = await fetch(url, { signal, headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const raw = await res.json();
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const at = (r.addresstype || r.type || "").toLowerCase();
    if (!CITY_TYPES.has(at)) continue;
    const fmt = formatNominatim(r);
    if (!fmt) continue;
    const k = `${fmt.name}|${fmt.country}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(fmt);
  }
  NOMINATIM_CACHE.set(key, out);
  return out;
}

function CityAutocomplete({ value, onChange, placeholder }) {
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  const safeValue = (value ?? "").toString();
  const q = safeValue.trim();
  useEffect(() => {
    // Cancel any pending request/debounce.
    if (timerRef.current) clearTimeout(timerRef.current);
    if (abortRef.current) abortRef.current.abort();
    setErrored(false);
    if (q.length < 2) { setRemote([]); setLoading(false); return; }
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      const ctl = new AbortController();
      abortRef.current = ctl;
      try {
        const results = await geocodeNominatim(q, ctl.signal);
        if (!ctl.signal.aborted) { setRemote(results); setLoading(false); }
      } catch (err) {
        if (err && err.name === "AbortError") return;
        setErrored(true);
        setRemote([]);
        setLoading(false);
      }
    }, 350);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [q]);

  return (
    <Autocomplete
      value={safeValue}
      onChange={onChange}
      placeholder={placeholder}
      loading={loading}
      emptyHint={errored ? "Couldn’t reach world search — type a known city." : "No matches yet — keep typing…"}
      getSuggestions={(qLower) => {
        const curated = CITIES.filter(c =>
          c.name.toLowerCase().includes(qLower) || c.country.toLowerCase().includes(qLower)
        );
        const seen = new Set(curated.map(c => `${c.name}|${c.country}`.toLowerCase()));
        const extras = remote.filter(r => !seen.has(`${r.name}|${r.country}`.toLowerCase()));
        return [...curated, ...extras];
      }}
      renderItem={(c) => <>{c.name}<span className="country">{c.country}{c._src === "world" ? " · world" : ""}</span></>}
      itemToValue={(c) => `${c.name}, ${c.country}`}
      itemKey={(c) => `${c.name}-${c.country}-${c._src || "curated"}`}
    />
  );
}

// Attempt to recover a parseable JSON object from a truncated stream. Strategy:
// walk forward tracking brace depth (while ignoring braces inside strings),
// remember the position right after the last completed top-level child of the
// outer object, then close the outer braces.
function salvageTruncatedJSON(str) {
  if (!str) return null;
  let i = 0;
  const len = str.length;
  while (i < len && str[i] !== "{") i++;
  if (i >= len) return null;
  const start = i;
  let depth = 0;
  let inStr = false;
  let escape = false;
  let lastSafeClose = -1; // index of a '}' or ']' at depth 1 (top-level child boundary)
  for (; i < len; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1) lastSafeClose = i; // just closed a top-level child
      if (depth === 0) {
        // Already balanced — nothing to salvage; caller's normal parse would have worked.
        return null;
      }
    }
  }
  if (lastSafeClose < 0) return null;
  // Truncate after the last safe close and append closers for whatever remains open.
  let head = str.slice(start, lastSafeClose + 1);
  // Walk head to figure out what's still open.
  let s = false; let esc = false;
  const stack = [];
  for (let k = 0; k < head.length; k++) {
    const c = head[k];
    if (esc) { esc = false; continue; }
    if (s) { if (c === "\\") { esc = true; continue; } if (c === '"') s = false; continue; }
    if (c === '"') { s = true; continue; }
    if (c === "{" || c === "[") { stack.push(c); }
    else if (c === "}" || c === "]") { stack.pop(); }
  }
  // Remove a trailing comma if present, then close remaining open structures.
  head = head.replace(/,\s*$/, "");
  while (stack.length) {
    const open = stack.pop();
    head += open === "{" ? "}" : "]";
  }
  return head;
}

// Module-level poller for /api/build/<jobId>. Used by both the main plan-build
// flow and the professional-review / revision flows. Polls GET with cursor,
// appends server-side deltas to a running buffer via onDelta, resolves with
// the final accumulated length when status flips to 'done'. Throws on error
// or notFound. The signal cancels polling without killing the server-side
// job (build keeps running for the next reconnect).
async function pollBuildJob({ jobId, signal, onDelta, pollMs = 1500 }) {
  let cursor = 0;
  while (true) {
    if (signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    let resp;
    try {
      resp = await fetch(`/api/build/${encodeURIComponent(jobId)}?cursor=${cursor}`, {
        signal,
        headers: { "Cache-Control": "no-cache" },
      });
    } catch (netErr) {
      if (netErr?.name === "AbortError") throw netErr;
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    if (resp.status === 404) {
      const err = new Error("Job not found or expired.");
      err.notFound = true;
      throw err;
    }
    if (!resp.ok) {
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    const data = await resp.json();
    if (data?.error?.message) throw new Error(data.error.message);
    if (data.delta) {
      cursor = data.cursor;
      if (typeof onDelta === "function") onDelta(data.delta, cursor);
    }
    if (data.status === "done") return { len: data.cursor };
    if (data.status === "error") throw new Error(data.error || "Build failed on server.");
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// Start a /api/build job with an arbitrary Anthropic body (model/system/messages/tools).
// Returns the jobId. Throws on HTTP error.
async function startBuildJob(body) {
  const r = await fetch("/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    let msg = `Could not start job (HTTP ${r.status}).`;
    try { const j = JSON.parse(txt); msg = j?.error?.message || msg; } catch { if (txt) msg = txt.slice(0, 240); }
    throw new Error(msg);
  }
  const out = await r.json();
  if (!out?.jobId) throw new Error("Server did not return a jobId.");
  return out.jobId;
}

// Parse a tool-input JSON buffer with salvage fallback. Returns { parsed, truncated }.
function parseToolJson(toolJson) {
  if (!toolJson) throw new Error("Empty response.");
  try {
    return { parsed: JSON.parse(toolJson), truncated: false };
  } catch (parseErr) {
    const salvaged = salvageTruncatedJSON(toolJson);
    if (!salvaged) throw new Error("The response was cut off before it finished.", { cause: parseErr });
    try {
      return { parsed: JSON.parse(salvaged), truncated: true };
    } catch (salvageErr) {
      throw new Error("The response was cut off before it finished.", { cause: salvageErr });
    }
  }
}

// Look up an airport record by IATA code, city, or name fragment.
function lookupAirport(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return (
    AIRPORTS.find(a => a.code.toLowerCase() === v) ||
    AIRPORTS.find(a => a.city.toLowerCase() === v) ||
    AIRPORTS.find(a => a.code.toLowerCase().startsWith(v) || a.city.toLowerCase().startsWith(v)) ||
    null
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

// Sel supports two modes:
//  - single (default): controlled by a string `value` + onChange({target:{value}})
//  - multi: pass `multi` + array `value` (e.g. ["Marriott","Hyatt"]); selection
//    is rendered as toggle-chip list, onChange receives the new array via
//    {target:{value:newArr}}.
// First option is treated as the "no preference" sentinel for the multi flow
// (selecting it clears all other selections; selecting any other unselects it).
function Sel({ value, onChange, opts, multi = false, placeholder = "No preference" }) {
  if (!multi) {
    const safeVal = value || "";
    return (
      <select value={safeVal} onChange={onChange} style={{ fontSize: "13px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: safeVal ? "var(--color-text-primary)" : "var(--color-text-secondary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", appearance: "none", cursor: "pointer" }}>
        <option value="">{placeholder}</option>
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  // Multi: chip toggles. `value` is array (or stringy-legacy; coerce).
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  const isNone = arr.length === 0;
  const toggle = (opt) => {
    let next;
    if (arr.includes(opt)) next = arr.filter(x => x !== opt);
    else next = [...arr, opt];
    onChange({ target: { value: next } });
  };
  const clearAll = () => onChange({ target: { value: [] } });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: "6px 0", borderBottom: "0.5px solid var(--color-border-primary)" }}>
      <button type="button" onClick={clearAll}
        style={{ fontSize: "11px", padding: "5px 9px", borderRadius: "12px", border: `0.5px solid ${isNone ? GOLD : "var(--color-border-secondary)"}`, background: isNone ? `${GOLD}22` : "transparent", color: isNone ? GOLD : "var(--color-text-secondary)", fontWeight: isNone ? 600 : 400, cursor: "pointer", fontFamily: "inherit" }}>
        {placeholder}
      </button>
      {opts.map(o => {
        const on = arr.includes(o);
        return (
          <button key={o} type="button" onClick={() => toggle(o)}
            style={{ fontSize: "11px", padding: "5px 9px", borderRadius: "12px", border: `0.5px solid ${on ? GOLD : "var(--color-border-secondary)"}`, background: on ? `${GOLD}22` : "transparent", color: on ? GOLD : "var(--color-text-primary)", fontWeight: on ? 600 : 400, cursor: "pointer", fontFamily: "inherit" }}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

// Coerce an array-or-string preference field into a human-readable phrase
// for the system prompt. Returns "No preference" when empty.
function prefToText(v) {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "No preference";
  return v || "No preference";
}

function TagInput({ placeholder, tags, setTags, suggestions = [] }) {
  const [val, setVal] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

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
    if (!trimmed) {
      // Empty + Add click: focus the input and open suggestions so the user
      // sees a path forward instead of a silent no-op. Previously this
      // returned nothing and made the button feel broken.
      try { inputRef.current?.focus(); } catch {}
      setOpen(true);
      setActiveIdx(-1);
      return;
    }
    if (!tags.includes(trimmed)) setTags([...tags, trimmed]);
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
            ref={inputRef}
            value={val}
            onChange={e => { setVal(e.target.value); setOpen(true); setActiveIdx(-1); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            style={{ width: "100%", fontSize: "13px", padding: "8px 0", border: "none", borderBottom: `0.5px solid var(--color-border-primary)`, background: "transparent", color: "var(--color-text-primary)", outline: "none", fontFamily: "inherit" }}
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

// ----------------------------------------------------------------------------
// Anthropic tool_use schema. Forces the model to produce structured JSON that
// matches this shape — no more truncation, no more empty days[], no more
// "summary in logistics" failures. The API validates before responding.
// ----------------------------------------------------------------------------
const MENU_DISH_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    price: { type: "string" },
  },
  required: ["name"],
};

const MENU_SCHEMA = {
  type: "object",
  description: "Representative menu reconstructed from typical offerings.",
  properties: {
    style_note: { type: "string" },
    signature_dishes: { type: "array", items: MENU_DISH_SCHEMA },
    appetizers: { type: "array", items: MENU_DISH_SCHEMA },
    mains: { type: "array", items: MENU_DISH_SCHEMA },
    desserts: { type: "array", items: MENU_DISH_SCHEMA },
    wine_and_drinks: { type: "array", items: MENU_DISH_SCHEMA },
    source_note: { type: "string", description: "Disclaimer that menus change." },
  },
};

const RESTAURANT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    neighborhood: { type: "string" },
    cuisine: { type: "string" },
    price_range: { type: "string", description: "$, $$, $$$, or $$$$" },
    why: { type: "string", description: "Insider, opinionated 1–2 sentence reason." },
    closure_note: { type: "string", description: "Confirm closure-day awareness given the weekday of the meal." },
    reservation: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["opentable", "resy", "tock", "yelp", "phone", "walkin"] },
        url: { type: "string" },
        phone: { type: "string" },
      },
      required: ["platform"],
    },
    menu: MENU_SCHEMA,
  },
  required: ["name", "cuisine", "why"],
};

// Backup is the same shape but allowed to be slimmer.
const BACKUP_SCHEMA = { ...RESTAURANT_SCHEMA, description: "Same-tier fallback in the same neighborhood / cuisine family." };

const FLIGHT_SCHEMA = {
  type: "object",
  description: "Structured flight details. Required for any item with type=Flight.",
  properties: {
    carrier: { type: "string", description: "Full airline name, e.g. 'United', 'Delta', 'JetBlue'." },
    flight_number: { type: "string", description: "Specific flight number, e.g. 'UA 1234'. Use a realistic flight number that the carrier is known to operate on this route. Will be flagged in UI as 'verify at booking' — never claim a specific flight is guaranteed." },
    from_airport: { type: "string", description: "Origin IATA code, e.g. 'EWR'." },
    to_airport: { type: "string", description: "Destination IATA code, e.g. 'ABQ'." },
    depart_time: { type: "string", description: "Local 24h time at origin, e.g. '08:45'." },
    arrive_time: { type: "string", description: "Local 24h time at destination, e.g. '11:20'." },
    duration: { type: "string", description: "e.g. '4h 35m'." },
    nonstop: { type: "boolean" },
    connection: { type: "string", description: "If not nonstop, the connecting airport code, e.g. 'DEN'." },
    cabin: { type: "string", description: "e.g. 'Polaris Business', 'First', 'Economy Plus'." },
    aircraft: { type: "string", description: "e.g. 'Boeing 737-900', 'Airbus A321neo'." },
    confirmation_note: { type: "string", description: "Booking guidance, e.g. 'Book directly on united.com for Polaris lounge access'." },
  },
  required: ["carrier", "flight_number", "from_airport", "to_airport", "depart_time", "arrive_time", "nonstop"],
};

const HOTEL_ITEM_SCHEMA = {
  type: "object",
  description: "Structured hotel check-in/check-out details. Use for any Hotel-type item.",
  properties: {
    name: { type: "string" },
    address: { type: "string" },
    phone: { type: "string", description: "Direct line, formatted +1-505-988-3030. Tappable in-app." },
    check_in_time: { type: "string", description: "e.g. '15:00'." },
    check_out_time: { type: "string", description: "e.g. '11:00'." },
    room_type: { type: "string" },
    confirmation_note: { type: "string" },
  },
};

const DAY_ITEM_SCHEMA = {
  type: "object",
  properties: {
    time: { type: "string", description: "REQUIRED. Local 24h start time for this item, e.g. '08:30', '12:00', '19:30'. Must be present on EVERY item so the day reads chronologically." },
    end_time: { type: "string", description: "Optional local 24h end time, e.g. '10:00'. Use for activities and meals with a known duration." },
    type: { type: "string", enum: ["Flight", "Hotel", "Activity", "Breakfast", "Brunch", "Lunch", "Dinner", "Transport", "Note"] },
    text: { type: "string", description: "Short headline of the item — what it is and where, no times (times go in the time field)." },
    location: { type: "string", description: "Specific venue or address when applicable." },
    duration: { type: "string", description: "Human-readable duration if useful, e.g. '2 hours', '90 min'." },
    flight: FLIGHT_SCHEMA,
    hotel: HOTEL_ITEM_SCHEMA,
    restaurant: { ...RESTAURANT_SCHEMA, properties: { ...RESTAURANT_SCHEMA.properties, backup: BACKUP_SCHEMA } },
  },
  required: ["time", "type", "text"],
};

const DAY_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "e.g. 'Day 1 · Thu Jun 4 · Arrive Santa Fe'" },
    city: { type: "string", description: "Which city this day belongs to on multi-city trips (e.g. 'Santa Fe, NM'). Match the spelling in the cities[] array. Transit days that span two cities use 'From→To' format (e.g. 'Santa Fe → Taos')." },
    headline: { type: "string", description: "REQUIRED. The one signature moment of the day, written as a vivid 6–10 word phrase. Examples: 'Sunset margaritas on the Anasazi rooftop' · 'Walk Canyon Road slowly before the galleries close' · 'Drive to Abiquiú for the Pedernal light'. Never leave blank." },
    weather: { type: "string", description: "REQUIRED. Seasonal expectation for this destination/date: high/low + sky + any caveat. e.g. 'High 82°F / low 52°F · sun w/ 30% PM thunderstorm risk'. Use seasonal norms; never fabricate live forecasts." },
    pace_note: { type: "string", description: "Optional 1-line pacing call: 'easy arrival', 'big driving day', 'spa & slow', etc." },
    items: { type: "array", items: DAY_ITEM_SCHEMA, minItems: 3 },
  },
  required: ["label", "headline", "weather", "items"],
};

// IMPORTANT: property declaration order matters here. Anthropic models tend to
// emit fields in the order they appear in the schema. days[] MUST be declared
// before the smaller string-array fields (logistics/flags/planb) so the model
// commits the expensive content first — if anything gets truncated, we lose
// the tail (insider notes, plan B) instead of the entire itinerary.
const TRIP_PLAN_TOOL = {
  name: "submit_trip_plan",
  description: "Submit the finalized luxury trip plan to the user. You MUST call this tool with a complete plan. CRITICAL: emit fields in this exact order: destination, meta, days, then everything else. days[] is the main deliverable — write it BEFORE logistics, flags, planb, snobs, or tonight.",
  input_schema: {
    type: "object",
    properties: {
      destination: { type: "string", description: "WRITE FIRST. For multi-city trips, join cities with arrows: 'Santa Fe → Taos → Albuquerque'." },
      meta: { type: "string", description: "WRITE SECOND. One-line summary: Dates · N nights · N travelers · Style. For multi-city, indicate the leg structure too (e.g. 'Sat–Sat · 3+2+2 nights')." },
      cities: {
        type: "array",
        description: "REQUIRED for multi-city trips, omit for single-city. One entry per leg in travel order. Inter-city transport (drive/fly time + distance) is captured in each city's transport_in field. Day count per city should match the user-requested nights for that city.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "City name as the user entered it (e.g. 'Santa Fe, NM')." },
            nights: { type: "integer", description: "Nights at this city." },
            days_range: { type: "string", description: "e.g. 'Day 1–Day 3' or 'Day 4–Day 5'." },
            focus: { type: "string", description: "What this leg is FOR — the why. e.g. 'Galleries + food on Canyon Road', 'Skiing & mountain lunches', 'Day trips to Bandelier'." },
            transport_in: { type: "string", description: "How the traveler ARRIVES at this city. For Leg 1: 'Fly EWR→ABQ · 4h 30m nonstop · then 1h drive to Santa Fe'. For later legs: 'Drive Santa Fe→Taos · 1h 15m · 70 miles via US-285' or 'Fly SFO→LAX · 1h 25m'. Include time AND distance for drives, time only for flights." },
            stay: { type: "string", description: "The recommended hotel/lodging name for this leg." },
          },
          required: ["name", "nights", "days_range"],
        },
        maxItems: 3,
      },
      days: {
        type: "array",
        description: "WRITE THIRD — THIS IS THE MAIN DELIVERABLE. Day-by-day plan. Must have exactly nights+1 entries. Never empty. Write this BEFORE logistics/flags/planb/snobs/tonight.",
        items: DAY_SCHEMA,
        minItems: 1,
      },
      logistics: {
        type: "array",
        description: "WRITE AFTER DAYS. Short chips only (≤6 chips, ≤40 chars each). Top-line facts. NO long sentences.",
        items: { type: "string" },
        maxItems: 6,
      },
      weather_window: { type: "string", description: "WRITE AFTER DAYS. 1–2 sentence seasonal weather expectation for the trip dates + any pattern the traveler should plan around (e.g. afternoon monsoons, midday heat). Never fabricate a live forecast." },
      pack: {
        type: "array",
        description: "WRITE AFTER DAYS. 4–8 destination-specific packing or prep essentials that are NOT obvious (e.g. 'Aspirin for altitude headache', 'Layers — evenings drop 30°F', 'Cash for Canyon Road galleries'). Skip the obvious (passport, phone charger).",
        items: { type: "string" },
        minItems: 3,
        maxItems: 8,
      },
      flags: { type: "array", items: { type: "string" }, description: "WRITE AFTER DAYS. Constraint flags: closures, booking lead times." },
      planb: {
        type: "array",
        items: { type: "string" },
        description: "WRITE AFTER DAYS. AT LEAST 5 disruption alternatives. Cover at minimum: weather/rain, a sold-out marquee restaurant, a closed-day activity, a transport disruption (canceled flight / car issue), and a health/altitude/illness day. Each entry: brief scenario → concrete substitute.",
        minItems: 5,
      },
      snobs: { type: "array", items: { type: "string" }, description: "WRITE LAST. Insider tone notes." },
      tonight: { type: "array", items: { type: "string" }, description: "WRITE LAST. Action items to do tonight — each prefixed with priority: '⚠︎ Must today:', '· This week:', or 'Anytime:'. Most urgent first." },
    },
    required: ["destination", "meta", "days"],
  },
};

// ============================================================================
// PROFESSIONAL REVIEW SYSTEM
// ----------------------------------------------------------------------------
// After a plan is generated, the user can request a professional review from
// a curated set of editorial / hotel / restaurant / local-voice sources. The
// reviewer produces a structured set of findings (no free-form prose) which
// the user can selectively apply. Surgical-mode card swaps re-run the same
// /api/build pipeline with REVISION_TOOL in patches mode; broader changes
// (pacing, neighborhood, day restructure) trigger a full re-plan with the
// reviewer's findings injected into the system prompt.
// ============================================================================

// 12 reviewer sources organized into 4 lens groups. Default = the 4 marked
// `dflt: true` (Condé Nast, Michelin Guide, NYT 36 Hours, Reddit + locals)
// which together cover editorial / restaurants / itinerary pacing / local truth.
const REVIEWER_SOURCES = [
  // Editorial lens — overall trip shape, taste level, neighborhood selection.
  { id: "cnt",        name: "Condé Nast Traveler",           lens: "editorial",   dflt: true,  blurb: "Hot Lists, Reader's Choice" },
  { id: "tl",         name: "Travel + Leisure",              lens: "editorial",   dflt: false, blurb: "World's Best, A-List advisors" },
  { id: "departures", name: "Departures",                    lens: "editorial",   dflt: false, blurb: "Amex Platinum — high-end taste" },
  // Hotels lens — property quality, service, room hierarchy.
  { id: "forbes",     name: "Forbes Travel Guide",           lens: "hotels",      dflt: false, blurb: "5-star service standards" },
  { id: "michelinK",  name: "Michelin Keys",                 lens: "hotels",      dflt: false, blurb: "New 1–3 Key hotel rating" },
  { id: "lqa",        name: "LQA / Leading Hotels",          lens: "hotels",      dflt: false, blurb: "Mystery-shop service audits" },
  // Restaurants lens — culinary quality, reservation logic, scene fit.
  { id: "michelinG",  name: "Michelin Guide",                lens: "restaurants", dflt: true,  blurb: "Stars, Bib Gourmand, Plates" },
  { id: "w50b",       name: "World's 50 Best",               lens: "restaurants", dflt: false, blurb: "Global voting body" },
  { id: "eater",      name: "Eater",                         lens: "restaurants", dflt: false, blurb: "City-level Heatmaps & Essential 38" },
  // Local voice lens — pacing, walkability, when-to-go, what locals actually do.
  { id: "nyt36",      name: "NYT 36 Hours",                  lens: "local",       dflt: true,  blurb: "Tight, pacing-aware day plans" },
  { id: "ftHTSI",     name: "FT How to Spend It",            lens: "local",       dflt: false, blurb: "Bloomberg Pursuits–style insider picks" },
  { id: "reddit",     name: "Reddit + locals",               lens: "local",       dflt: true,  blurb: "r/travel, r/[city] real talk" },
];

const REVIEWER_LENSES = [
  { id: "editorial",   label: "Editorial",       why: "Overall trip taste, shape, and neighborhood logic — do the days hold together as a coherent stay." },
  { id: "hotels",      label: "Hotels",          why: "Property tier, service, and room hierarchy — is this the right hotel for the trip's price and purpose." },
  { id: "restaurants", label: "Restaurants",     why: "Culinary quality, reservation feasibility, scene fit — would a serious diner make these picks." },
  { id: "local",       label: "Local voice",     why: "Pacing, walkability, what locals actually do — does the plan move like a local would, or a tourist." },
];

// findings[].mode_hint controls the surgical-vs-full router. Card-targeted
// hints can be applied as a JSON patch; structural hints require a re-plan.
const CARD_TARGETED_HINTS = new Set([
  "swap_restaurant",
  "swap_hotel",
  "swap_planb",
  "swap_activity",
  "adjust_logistics",
  "add_flag",
  "add_tonight",
]);
const STRUCTURAL_HINTS = new Set([
  "adjust_pacing",
  "change_neighborhood",
  "restructure_day",
  "rebalance_legs",
  "change_hotel_brand_tier",
]);

// Format a finding.target ({day, time, item} | string) into a short chip label.
function formatFindingTarget(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (typeof t !== "object") return String(t);
  const parts = [];
  if (t.day != null) parts.push(`Day ${t.day}`);
  if (t.time) parts.push(String(t.time));
  if (t.label) parts.push(String(t.label));
  if (t.item) parts.push(String(t.item));
  if (t.section) parts.push(String(t.section));
  if (parts.length === 0) {
    try { return JSON.stringify(t); } catch { return ""; }
  }
  return parts.join(" · ");
}

// Decide which revision path to use given the set of findings the user marked
// for Apply. Returns 'surgical' if every selected finding has a card-targeted
// mode_hint AND there are at most 3 findings. Returns 'full' otherwise.
function routeRevisionMode(selectedFindings) {
  if (!Array.isArray(selectedFindings) || selectedFindings.length === 0) return null;
  if (selectedFindings.length > 3) return "full";
  for (const f of selectedFindings) {
    if (!f?.mode_hint || !CARD_TARGETED_HINTS.has(f.mode_hint)) return "full";
  }
  return "surgical";
}

const REVIEW_TOOL = {
  name: "submit_review",
  description: "Submit a structured professional review of an existing trip plan. NO free-form prose — only call this tool with a verdict + findings[] array. Each finding is a single, actionable observation a luxury concierge would flag. Critical findings = real problems that hurt the trip. Suggested = clear upgrades. Nice-to-have = polish.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        description: "One-line overall verdict in the format 'A | B+ | B | C+ | C — short rationale (≤14 words)'. Examples: 'B+ — strong hotels, but Day 2 pacing is too aggressive', 'A — tight, well-balanced, no notes'.",
      },
      findings: {
        type: "array",
        description: "Each finding is ONE actionable observation. Order by severity (critical first), then by day order. AT LEAST 1 finding unless verdict is A with no notes. Cap at 8 findings — pick the highest-impact issues only.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable id: 'f1', 'f2', 'f3', etc. — used to track Apply selections." },
            severity: { type: "string", enum: ["critical", "suggested", "nice"], description: "critical = real problem that hurts the trip (e.g. closed restaurant, impossible drive time, hotel mismatch). suggested = clear upgrade (better-fitting hotel, more interesting restaurant). nice = polish (timing tweak, micro-substitution)." },
            lens: { type: "string", enum: ["editorial", "hotels", "restaurants", "local"], description: "Which lens flagged this. Must match the lens of the source(s) supporting it." },
            source: { type: "string", description: "Which reviewer source(s) flag this, comma-separated. Use the source names exactly: 'Condé Nast Traveler', 'Michelin Guide', 'NYT 36 Hours', 'Reddit + locals', etc." },
            target: { type: "string", description: "What this finding is ABOUT, in the user's language. Format: 'Day N · context' or 'Hotel' or 'Pacing' or 'Plan B'. Examples: 'Day 2 · lunch', 'Day 3 · hotel', 'Pacing — Days 4–5', 'Plan B'." },
            summary: { type: "string", description: "One sentence (≤22 words) stating the issue. Plain, specific, no hedging. Example: 'Dinner at Geranium on Day 3 needs a 2–3 month reservation; the plan assumes walk-in.'" },
            action: { type: "string", description: "One sentence (≤22 words) stating the concrete change to make. Example: 'Swap to Alchemist (similar tier, easier reservation) or move Geranium to Day 1 and book now.'" },
            mode_hint: { type: "string", enum: ["swap_restaurant", "swap_hotel", "swap_planb", "swap_activity", "adjust_logistics", "add_flag", "add_tonight", "adjust_pacing", "change_neighborhood", "restructure_day", "rebalance_legs", "change_hotel_brand_tier"], description: "Categorizes the kind of change. Swap_* hints can be applied as a card-level patch. Structural hints (adjust_pacing, change_neighborhood, restructure_day, rebalance_legs, change_hotel_brand_tier) require a full re-plan." },
            default_apply: { type: "boolean", description: "Whether the Apply toggle should default ON. Set true for critical findings, false for nice findings; for suggested findings use your judgment based on impact." },
          },
          required: ["id", "severity", "lens", "source", "target", "summary", "action", "mode_hint", "default_apply"],
        },
        maxItems: 8,
      },
    },
    required: ["verdict", "findings"],
  },
};

const REVISION_TOOL_SURGICAL = {
  name: "submit_revision_patches",
  description: "Apply a small set of surgical patches to an existing trip plan. Each patch describes ONE replacement: a new item to put in place of an existing item identified by day index + item index. The client merges these patches into the plan locally. Use this ONLY when the changes are card-level swaps (restaurant, hotel, plan B, activity). Do NOT use for pacing or neighborhood changes.",
  input_schema: {
    type: "object",
    properties: {
      patches: {
        type: "array",
        description: "At most 5 patches. Each patch targets one specific card.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["replace_item", "replace_hotel", "replace_planb_entry", "add_flag", "add_tonight"], description: "What kind of patch. replace_item swaps one day's item (restaurant/activity/transport). replace_hotel swaps the hotel item for a day. replace_planb_entry replaces one Plan B entry by index. add_flag / add_tonight append a new string." },
            day_index: { type: "integer", description: "0-based day index. Required for replace_item and replace_hotel." },
            item_index: { type: "integer", description: "0-based item index within day.items[]. Required for replace_item." },
            planb_index: { type: "integer", description: "0-based index into planb[]. Required for replace_planb_entry." },
            new_item: { type: "object", description: "The replacement item, matching the DAY_SCHEMA items shape (type, name, time, location, etc.). Required for replace_item / replace_hotel.", additionalProperties: true },
            new_text: { type: "string", description: "The replacement text. Required for replace_planb_entry / add_flag / add_tonight." },
            rationale: { type: "string", description: "One short sentence (≤18 words) explaining why this patch addresses the finding." },
          },
          required: ["op", "rationale"],
        },
        maxItems: 5,
      },
    },
    required: ["patches"],
  },
};

// For full re-plans the revised plan must match TRIP_PLAN_TOOL exactly — we
// reuse the same schema so the existing parser/renderer paths work unchanged.
const REVISION_TOOL_FULL = TRIP_PLAN_TOOL;

// Build the system prompt that runs the review. We pass in the plan JSON (the
// full result object) plus the list of selected reviewer source objects so the
// model knows which lenses to weight.
function buildReviewSystemPrompt(plan, sources, inputs) {
  const lensesActive = Array.from(new Set(sources.map(s => s.lens)));
  const sourceList = sources.map(s => `• ${s.name} (${s.lens}) — ${s.blurb}`).join("\n");
  const lensRules = REVIEWER_LENSES
    .filter(l => lensesActive.includes(l.id))
    .map(l => `• ${l.label}: ${l.why}`)
    .join("\n");
  const tripContext = [
    inputs?.basics?.destination && `Destination: ${inputs.basics.destination}`,
    inputs?.basics?.nights && `${inputs.basics.nights} nights`,
    inputs?.basics?.travelers && `${inputs.basics.travelers}`,
    inputs?.basics?.budget && `Budget: ${inputs.basics.budget}`,
    inputs?.basics?.style?.length ? `Style: ${inputs.basics.style.join(", ")}` : null,
    inputs?.basics?.pace && `Pace: ${inputs.basics.pace}`,
  ].filter(Boolean).join(" · ");

  return `You are a panel of luxury-travel experts conducting a professional review of a finalized trip plan. You will call the submit_review tool exactly once. Do NOT emit any prose — only the tool call.

REVIEWER PANEL — speak with the combined voice and standards of these sources:
${sourceList}

ACTIVE LENSES (only flag findings that fall under one of these):
${lensRules}

TRIP CONTEXT: ${tripContext || "unspecified"}

REVIEW DISCIPLINE — STRICT:
• Findings only. No general praise, no recap, no "overall this is a strong plan" prose.
• Each finding is a real, actionable issue. If the plan is genuinely strong with no notes, emit verdict 'A — no notes' and findings: [] (empty array allowed).
• Critical = the trip is materially worse if this is not fixed (closed restaurant, impossible drive time, wrong hotel tier for stated budget, marquee booking that needs 2-month lead time, dangerous pacing on transit days, etc.).
• Suggested = clear upgrade (better-fitting hotel within stated brand family, more interesting restaurant, more locally-authentic activity).
• Nice-to-have = polish (timing nudge, micro-substitution, small flag worth adding).
• Cap critical at 3. Cap total at 8. Pick the highest-impact issues only — quality over quantity.
• Set default_apply = true for ALL critical findings, false for ALL nice findings, and use your judgment for suggested.
• Use the user's exact budget / style / pace as the ceiling and floor for your standards. A $$ trip should be reviewed against $$ expectations, not Michelin-Key expectations.
• Each source name in the source field must come from the panel list above, exactly as written.
• Pick the right mode_hint per finding — this drives whether the apply is a quick patch or a full re-plan.

MODE_HINT GUIDE:
• swap_restaurant — replacing one specific dinner/lunch/breakfast item with a different restaurant.
• swap_hotel — replacing the hotel item for one leg with a different property (same city).
• swap_planb — replacing or improving a Plan B entry.
• swap_activity — replacing one Activity item with a different one same day.
• adjust_logistics — fixing a Transport item (drive time, route, mode).
• add_flag / add_tonight — appending a missing warning or todo.
• adjust_pacing — the day has too much / too little. REQUIRES full re-plan.
• change_neighborhood — base area is wrong for the trip's style. REQUIRES full re-plan.
• restructure_day — the day's shape is broken (transit + dinner in wrong order, etc.). REQUIRES full re-plan.
• rebalance_legs — multi-city night allocation is off. REQUIRES full re-plan.
• change_hotel_brand_tier — hotel brand or tier is wrong for budget. REQUIRES full re-plan.

PLAN TO REVIEW (JSON):
${JSON.stringify(plan, null, 2)}`;
}

function buildReviewUserPrompt() {
  return "Review the plan above. Call submit_review exactly once with verdict + findings[].";
}

function buildRevisionSystemPromptSurgical(plan, findings, inputs) {
  const findingsBlock = findings.map(f =>
    `[${f.id}] (${f.severity}, ${f.mode_hint}, ${formatFindingTarget(f.target)}) ${f.summary} → ${f.action}`
  ).join("\n");
  const tripContext = [
    inputs?.basics?.destination && `Destination: ${inputs.basics.destination}`,
    inputs?.basics?.nights && `${inputs.basics.nights} nights`,
    inputs?.basics?.budget && `Budget: ${inputs.basics.budget}`,
  ].filter(Boolean).join(" · ");

  return `You are applying surgical card-level patches to an existing luxury trip plan. Call submit_revision_patches exactly once with a small patches[] array — one patch per finding. No prose.

TRIP CONTEXT: ${tripContext}

FINDINGS TO ADDRESS:
${findingsBlock}

PATCH RULES:
• Emit ONE patch per finding above (in the same order). Skip a finding only if it genuinely cannot be card-patched.
• Identify the right day_index and item_index by reading the plan JSON below. Days are 0-indexed; items[] within a day are 0-indexed.
• For replace_item: new_item must have type ('Restaurant' | 'Activity' | 'Transport' | 'Breakfast' | 'Lunch' | 'Dinner' | 'Hotel' | 'Flight'), name, time (24h), and any other relevant fields the original item had (location, reservation, notes, end_time). Match the structure of the existing item shape.
• For replace_hotel: same as replace_item but the new_item.type must be 'Hotel'.
• For replace_planb_entry: provide planb_index (0-based) and new_text.
• For add_flag / add_tonight: provide new_text only.
• Keep replacement choices consistent with the original budget and style. Don't upgrade or downgrade tier without cause.
• Rationale: one short sentence per patch, plain language.

PLAN TO PATCH (JSON):
${JSON.stringify(plan, null, 2)}`;
}

function buildRevisionUserPromptSurgical() {
  return "Apply the findings above as surgical patches. Call submit_revision_patches exactly once.";
}

function buildRevisionSystemPromptFull(plan, findings, inputs) {
  const findingsBlock = findings.map(f =>
    `• [${f.severity}/${f.mode_hint}] ${formatFindingTarget(f.target)} — ${f.summary} → ${f.action}`
  ).join("\n");
  const tripContext = [
    inputs?.basics?.destination && `Destination: ${inputs.basics.destination}`,
    inputs?.basics?.nights && `${inputs.basics.nights} nights`,
    inputs?.basics?.travelers && `${inputs.basics.travelers}`,
    inputs?.basics?.budget && `Budget: ${inputs.basics.budget}`,
    inputs?.basics?.style?.length ? `Style: ${inputs.basics.style.join(", ")}` : null,
    inputs?.basics?.pace && `Pace: ${inputs.basics.pace}`,
  ].filter(Boolean).join(" · ");
  const nightsNum = parseInt(inputs?.basics?.nights, 10) || (Array.isArray(plan?.days) ? Math.max(1, plan.days.length - 1) : 3);
  const totalDays = nightsNum + 1;

  return `You are revising a luxury trip plan based on a professional review. Call the submit_trip_plan tool exactly once with the FULL revised plan — same schema as the original. Do not emit any prose.

TRIP CONTEXT: ${tripContext}
Target: ${totalDays} days (${nightsNum} nights).

REVIEWER FINDINGS TO ADDRESS:
${findingsBlock}

REVISION RULES:
• Re-emit the COMPLETE plan with every field (destination, meta, days, logistics, weather_window, pack, flags, planb, snobs, tonight). Do not return a partial plan.
• Address every finding above. Where a finding calls for pacing or neighborhood changes, restructure the affected days fully — don't just relabel.
• Preserve what was working: keep restaurants, hotels, and activities that the review did NOT flag, unless adjusting them is necessary to fix a flagged issue.
• Same field emission order rule applies: destination, meta, ${Array.isArray(plan?.cities) && plan.cities.length > 1 ? "cities, " : ""}days, then logistics/flags/planb/snobs/tonight last.
• days[] must contain exactly ${totalDays} entries.
• VARIETY: no restaurant repeats across days. Each unique name appears at most once across the whole plan.
• EVERY item in items[] MUST have a "time" field (24h local time).
• If a finding's mode_hint is 'change_hotel_brand_tier', change the hotel item AND update any related fields (transport_in if hotel moved across town, neighborhood references in headlines, etc.) — keep the plan internally consistent.

ORIGINAL PLAN (use as starting point — change only what the findings require):
${JSON.stringify(plan, null, 2)}`;
}

function buildRevisionUserPromptFull() {
  return "Revise the plan above to address every finding. Call submit_trip_plan exactly once with the complete revised plan.";
}

// Apply surgical patches client-side. Returns a new plan object (does not mutate).
// Each patch op:
//   replace_item       — plan.days[day_index].items[item_index] = new_item
//   replace_hotel      — same, but asserts new_item.type === 'Hotel'
//   replace_planb_entry— plan.planb[planb_index] = new_text
//   add_flag           — push new_text into plan.flags
//   add_tonight        — push new_text into plan.tonight
function applyPatchesToPlan(plan, patches) {
  if (!plan || !Array.isArray(patches)) return plan;
  // Deep-clone the parts we'll mutate so React notices the change.
  const next = { ...plan };
  next.days = Array.isArray(plan.days) ? plan.days.map(d => ({ ...d, items: Array.isArray(d.items) ? [...d.items] : [] })) : [];
  next.planb = Array.isArray(plan.planb) ? [...plan.planb] : [];
  next.flags = Array.isArray(plan.flags) ? [...plan.flags] : [];
  next.tonight = Array.isArray(plan.tonight) ? [...plan.tonight] : [];

  for (const p of patches) {
    if (!p || !p.op) continue;
    try {
      if (p.op === "replace_item" && typeof p.day_index === "number" && typeof p.item_index === "number" && p.new_item) {
        const day = next.days[p.day_index];
        if (day && Array.isArray(day.items) && p.item_index >= 0 && p.item_index < day.items.length) {
          day.items[p.item_index] = p.new_item;
        }
      } else if (p.op === "replace_hotel" && typeof p.day_index === "number" && p.new_item) {
        const day = next.days[p.day_index];
        if (day && Array.isArray(day.items)) {
          // Replace the FIRST hotel-typed item on that day. If none, append.
          const hotelIdx = day.items.findIndex(it => it && typeof it.type === "string" && it.type.toLowerCase() === "hotel");
          if (hotelIdx >= 0) day.items[hotelIdx] = { ...p.new_item, type: "Hotel" };
          else day.items.push({ ...p.new_item, type: "Hotel" });
        }
      } else if (p.op === "replace_planb_entry" && typeof p.planb_index === "number" && typeof p.new_text === "string") {
        if (p.planb_index >= 0 && p.planb_index < next.planb.length) {
          next.planb[p.planb_index] = p.new_text;
        }
      } else if (p.op === "add_flag" && typeof p.new_text === "string") {
        next.flags.push(p.new_text);
      } else if (p.op === "add_tonight" && typeof p.new_text === "string") {
        next.tonight.push(p.new_text);
      }
    } catch {
      // Swallow per-patch errors; we'd rather apply 4-of-5 patches than abort.
    }
  }
  return next;
}

export default function TripOptimizer() {
  // Form state is INTENTIONALLY NOT PERSISTED across launches. The user wants
  // a clean slate on every launch and after "Plan another trip". We still
  // write to localStorage during a session for crash recovery within the
  // same tab, but on mount we wipe it. Saved trips (multi-trip library) live
  // under SAVED_TRIPS_KEY and are unaffected.
  const LS_KEY = "trip-optimizer-form-v4";

  // BLANK = truly empty state. Used on every launch and on "Plan another trip".
  const BLANK = {
    basics: { destination: "", cities: [{ name: "", nights: "", focus: "" }], startDate: "", nights: "", travelers: "", baseArea: "", style: [], pace: "", budget: "" },
    flights: { homeAirport: "", airline: "", cabin: "", flex: "", noFlight: false },
    hotel: { brand: [], tier: "", mustHave: "" },
    transport: { type: [], company: "", vehicle: "" },
    dining: { cuisine: "", budget: [] },
    restaurants: [],
    activities: [],
    interests: { level: "", text: "" },
  };
  // DEFAULTS preserved only as fallback when a saved trip is missing a field on Open.
  const DEFAULTS = BLANK;

  // Wipe any leftover form state from a prior session as early as possible.
  // Runs once at module init — before the first render — so the form starts blank.
  try { localStorage.removeItem(LS_KEY); } catch {}

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [progress, setProgress] = useState(0);          // 0–1 estimated fraction
  const [progressLabel, setProgressLabel] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  // Tracks which saved-trip entry (if any) the current `result` came from.
  // When a saved trip is opened and then revised, we persist the revised plan
  // and review state back into THAT entry rather than creating a new one.
  const [currentSavedTripId, setCurrentSavedTripId] = useState(null);
  // _review state for the currently-displayed plan. Mirrored onto result so
  // it round-trips through saves; also lifted here so ItineraryView re-mounts
  // pick up the latest reviewer findings.
  const [reviewState, setReviewState] = useState(null);

  // Normalize basics: ensure cities[] exists even for saved sessions from before multi-city support.
  const normalizeBasics = (b) => {
    const src = b || DEFAULTS.basics;
    if (Array.isArray(src.cities) && src.cities.length > 0) return src;
    return { ...src, cities: [{ name: src.destination || "", nights: src.nights || "", focus: "" }] };
  };
  const [basics, setB] = useState(normalizeBasics(BLANK.basics));
  const [flights, setF] = useState(BLANK.flights);
  const [hotel, setH] = useState(BLANK.hotel);
  const [transport, setT] = useState(BLANK.transport);
  const [dining, setD] = useState(BLANK.dining);
  const [restaurants, setRest] = useState(BLANK.restaurants);
  const [activities, setActs] = useState(BLANK.activities);
  const [interests, setInt] = useState(BLANK.interests);

  // Reset every form bucket to BLANK. Used for "Plan another trip".
  const resetFormToBlank = () => {
    setB(normalizeBasics(BLANK.basics));
    setF(BLANK.flights);
    setH(BLANK.hotel);
    setT(BLANK.transport);
    setD(BLANK.dining);
    setRest(BLANK.restaurants);
    setActs(BLANK.activities);
    setInt(BLANK.interests);
    setResult(null);
    setError("");
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    setLoading(false); setLoadingMsg(""); setProgress(0); setProgressLabel(""); setElapsedSec(0);
    try { localStorage.removeItem(LS_KEY); } catch {}
  };

  // Saved trips list — hydrated from localStorage. Refreshed on save/delete/open.
  const [savedTrips, setSavedTrips] = useState(() => loadSavedTrips());
  const refreshSavedTrips = () => setSavedTrips(loadSavedTrips());
  const handleOpenSavedTrip = (entry) => {
    if (!entry || !entry.inputs || !entry.result) return;
    const i = entry.inputs;
    // CLEAR-BEFORE-OPEN. Reset every piece of form state to a clean baseline
    // first, then layer the saved entry on top. Without this, chips/fields
    // from the prior session bleed through whenever the saved entry doesn't
    // include that key (e.g. saved trip has no restaurants[] -> old chips
    // persist). Also wipes any in-flight error / loading state.
    setB(normalizeBasics(i.basics || DEFAULTS.basics));
    setF(i.flights || DEFAULTS.flights);
    setH(i.hotel || DEFAULTS.hotel);
    setT(i.transport || DEFAULTS.transport);
    setD(i.dining || DEFAULTS.dining);
    setRest(Array.isArray(i.restaurants) ? i.restaurants : []);
    setActs(Array.isArray(i.activities) ? i.activities : []);
    setInt(i.interests || DEFAULTS.interests);
    setOut(i.outputs || { itinerary: true, weather: true, navigation: true, logistics: true, tonight: true, menus: true, flags: true, planb: true, snobs: true, practical: false, badges: false, pronunciation: false });
    // Cancel any in-flight generation and clear transient UI state.
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    setLoading(false);
    setLoadingMsg("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);
    setError("");
    setResult(entry.result);
    setCurrentSavedTripId(entry.id || null);
    setReviewState(entry.result?._review || null);
    setStep(3);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const handleDeleteSavedTrip = (id) => {
    const next = loadSavedTrips().filter(t => t.id !== id);
    writeSavedTrips(next);
    setSavedTrips(next);
  };

  // Stale-chip detector. Runs on mount AND on any change to destination/chips.
  // Catches two scenarios:
  //  (a) user switches destination during the session
  //  (b) form loads from localStorage with destination + chips that don't match
  //      (the common real-world failure mode -- the prior fix only handled (a))
  const primaryDest = (basics.cities && basics.cities[0]?.name) || basics.destination || "";
  const [staleSuggestion, setStaleSuggestion] = useState(null);
  const dismissedRef = useRef(""); // remember dismissed signature to not re-pop after user dismissed
  useEffect(() => {
    const currentKey = destinationKey(primaryDest);
    const r = findOrphanedChips(restaurants, currentKey, RESTAURANT_BY_DEST);
    const a = findOrphanedChips(activities, currentKey, ACTIVITY_BY_DEST);
    if (r.staleChips.length === 0 && a.staleChips.length === 0) {
      setStaleSuggestion(null);
      return;
    }
    // Source key: prefer whichever has the most chips; fall back to either.
    const sourceKey = (r.staleChips.length >= a.staleChips.length ? r.sourceKey : a.sourceKey) || r.sourceKey || a.sourceKey;
    const signature = `${currentKey}|${sourceKey}|${r.staleChips.join(",")}|${a.staleChips.join(",")}`;
    if (dismissedRef.current === signature) return; // user already dismissed this exact set
    setStaleSuggestion({
      prevKey: sourceKey,
      newKey: currentKey,
      staleRestaurants: r.staleChips,
      staleActivities: a.staleChips,
      prevLabel: sourceKey ? sourceKey.replace(/\b\w/g, c => c.toUpperCase()) : "a different destination",
      newLabel: primaryDest || "your new destination",
      _sig: signature,
    });
  }, [primaryDest, restaurants, activities]);
  const clearStaleChips = () => {
    if (!staleSuggestion) return;
    if (staleSuggestion.staleRestaurants.length > 0) {
      setRest(restaurants.filter(r => !staleSuggestion.staleRestaurants.includes(r)));
    }
    if (staleSuggestion.staleActivities.length > 0) {
      setActs(activities.filter(a => !staleSuggestion.staleActivities.includes(a)));
    }
    setStaleSuggestion(null);
  };
  const dismissStale = () => {
    if (staleSuggestion?._sig) dismissedRef.current = staleSuggestion._sig;
    setStaleSuggestion(null);
  };

  // Auto-save form on every change.
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ basics, flights, hotel, transport, dining, restaurants, activities, interests }));
    } catch {}
  }, [basics, flights, hotel, transport, dining, restaurants, activities, interests]);
  const [outputs, setOut] = useState({ itinerary: true, weather: true, navigation: true, logistics: true, tonight: true, menus: true, flags: true, planb: true, snobs: true, practical: false, badges: false, pronunciation: false });

  const togOut = k => setOut(o => ({ ...o, [k]: !o[k] }));

  // Multi-city helpers. cities[] is the source of truth when length > 1.
  // For single-city, basics.destination/nights are authoritative for back-compat.
  const cities = (basics.cities && basics.cities.length > 0) ? basics.cities : [{ name: basics.destination || "", nights: basics.nights || "", focus: "" }];
  const isMultiCity = cities.length > 1;
  const totalNightsFromCities = cities.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
  const updateCity = (idx, patch) => {
    const next = cities.map((c, i) => i === idx ? { ...c, ...patch } : c);
    const newTotal = next.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
    setB({
      ...basics,
      cities: next,
      destination: next.map(c => c.name).filter(Boolean).join(" → ") || basics.destination,
      nights: next.length > 1 ? String(newTotal) : (next[0]?.nights || basics.nights),
    });
  };
  const addCity = () => {
    if (cities.length >= 3) return;
    const next = [...cities, { name: "", nights: "2", focus: "" }];
    const newTotal = next.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
    setB({ ...basics, cities: next, destination: next.map(c => c.name).filter(Boolean).join(" → ") || basics.destination, nights: String(newTotal) });
  };
  const removeCity = (idx) => {
    if (cities.length <= 1) return;
    const next = cities.filter((_, i) => i !== idx);
    const newTotal = next.reduce((s, c) => s + (parseInt(c.nights, 10) || 0), 0);
    setB({
      ...basics,
      cities: next,
      destination: next.length > 1 ? next.map(c => c.name).filter(Boolean).join(" → ") : (next[0]?.name || ""),
      nights: next.length > 1 ? String(newTotal) : (next[0]?.nights || basics.nights),
    });
  };

  const cityNamesValid = cities.every(c => c.name && c.name.trim());
  const cityNightsValid = cities.every(c => (parseInt(c.nights, 10) || 0) >= 1);
  const missing = [
    !cityNamesValid && (isMultiCity ? "All city names" : "Destination"),
    !basics.startDate.trim() && "Start date",
    !cityNightsValid && (isMultiCity ? "Nights for each city" : "Nights"),
    // Home airport only required when the user is actually flying. If they
    // tick "Not flying (driving / train)" we skip flight planning entirely.
    !flights.noFlight && !flights.homeAirport.trim() && "Home airport",
  ].filter(Boolean);
  const ready = missing.length === 0;
  const areaHint = getAreaHint(cities[0]?.name || basics.destination);
  const activeCount = Object.values(outputs).filter(Boolean).length;

  const buildSystemPrompt = () => {
    const totalNights = isMultiCity ? totalNightsFromCities : (parseInt(basics.nights, 10) || 3);
    const totalDays = totalNights + 1;
    const multiCityBlock = isMultiCity ? `

MULTI-CITY TRIP — STRUCTURE THIS CAREFULLY:
This is a ${cities.length}-city trip: ${cities.map((c, i) => `Leg ${i + 1} = ${c.name} (${c.nights} nights)`).join(", ")}.
Total: ${totalNights} nights = ${totalDays} days.
• Emit a cities[] array with ${cities.length} entries in this exact order: ${cities.map(c => c.name).join(" → ")}. Each entry needs name, nights, days_range, focus, transport_in, stay.
• Day allocation: Leg 1 gets ${cities[0]?.nights || 0} nights but ${(parseInt(cities[0]?.nights, 10) || 0) + 1} days (arrival day + nights). Subsequent legs get N nights = N days each (the inter-city transit happens AT THE START of the leg's first day). Final departure happens on the last day of the last leg (no extra day).
• Compute days_range for each leg: Leg 1 = Day 1–Day ${(parseInt(cities[0]?.nights, 10) || 0) + 1}. ${cities.length >= 2 ? `Leg 2 starts Day ${(parseInt(cities[0]?.nights, 10) || 0) + 2}.` : ""} ${cities.length === 3 ? `Leg 3 starts Day ${(parseInt(cities[0]?.nights, 10) || 0) + (parseInt(cities[1]?.nights, 10) || 0) + 2}.` : ""}
• Each day MUST have a "city" field with the city name. Transit days (the first day of legs 2 and 3) use "From→To" format (e.g. "Santa Fe → Taos").
• PACING for transit days: the first day of legs 2/3 is a transit day. Front-load the morning with checkout + drive/fly, then a relaxed arrival lunch in the new city, then a light afternoon activity. Don't pack a transit day full — the user is moving with luggage.
• INTER-CITY TRANSPORT: For each leg after Leg 1, include a Transport item at the START of that leg's first day with: realistic drive time, distance in miles AND km if international, route (highway/road number), and any pacing notes (rest stops, scenic detours). For flight transfers between cities, treat it as a Flight item.
• LUGGAGE / LOGISTICS REALITY: When the route is drive-based, the same rental car follows the whole trip — don't return it between cities. When the route mixes drive + fly, call out the rental car return + new pickup in flags[]. Hotel checkout times (usually 11:00–12:00) constrain how early you can hit the road; plan transit departures for 10:00–11:00 unless you note a late checkout.
• MINIMUM 2 NIGHTS per city when cities.length === 3 — if the user gave 1 night for a leg in a 3-city trip, set a flags[] warning that one night doesn't leave time to enjoy that city and suggest a re-balance.
• HOTEL ITEMS: One check-in Hotel item per leg (at arrival) and a check-out item on the last morning of each leg EXCEPT the final leg's check-out which is on the very last day before flying home. Each leg's stay must be a DIFFERENT hotel (different city = different hotel).
• weather and weather_window: if cities are in very different climates (mountain vs coast vs desert), call this out in weather_window AND give per-day weather that reflects the city's actual climate for that day.` : "";
    return `You are a luxury travel planner. Call the submit_trip_plan tool exactly once with the finalized plan. Do not emit any prose — only the tool call.

FIELD EMISSION ORDER — CRITICAL:
Write the tool input in this exact order: destination, meta, ${isMultiCity ? "cities, " : ""}days, logistics, flags, planb, snobs, tonight.
days[] is the main deliverable. Write the entire days[] array BEFORE writing logistics, flags, planb, snobs, or tonight. Never write logistics/flags/planb first and then days — if anything gets cut off, we lose the whole plan. Always write days first.${multiCityBlock}

TRIP REQUIREMENTS:
• days[] must contain exactly ${totalDays} entries (arrival day + ${parseInt(basics.nights,10)||3} full nights). Compute the correct weekday for each day starting from the start date.
• Each day MUST include: label, headline (the one-line "if you only do one thing" call), weather (seasonal expectation, NOT a live forecast), and items[].
• Each day's items[] needs at least 3 items — a typical full day is: morning Activity or Breakfast, midday Lunch, evening Dinner. Arrival/departure days also include Flight + Hotel.
• EVERY item in items[] MUST have a "time" field (24h local time, e.g. '08:30', '14:00', '19:30'). Items should appear in chronological order within each day. This is what turns the day into a real time-based itinerary instead of a vague list.
• Use realistic times: breakfast 07:30–09:00, lunch 12:00–13:30, dinner 19:00–20:30. Activities sized to their duration (museum 2h, hike 3–4h, gallery walk 90min). Add end_time when helpful.
• For Activity items, fill "location" with a specific venue or address.
• For Transport items between activities, the "text" should include estimated drive/walk time (e.g. 'Drive to Abiquiú — 1h 15min via US-84').

VARIETY RULES — STRICT, NON-NEGOTIABLE:
• Each unique restaurant name MUST appear AT MOST ONCE across ALL days. Before emitting any restaurant, mentally check: have I already used this name on an earlier day? If yes, pick a different one. The same name for breakfast Day 2 AND breakfast Day 4 is a violation. The same name for dinner Day 1 AND lunch Day 2 is a violation.
• The hotel's in-house restaurant counts as a restaurant. It may appear AT MOST ONCE across the entire trip. For other breakfasts, pick named local spots (e.g. Tia Sophia's, Café Pasqual's, Clafoutis) — never default to the hotel restaurant.
• If the user asked for a specific cuisine focus, give each day a different EXPRESSION of that cuisine: a market café, an institution, a chef-driven spot, a wine bar, a hole-in-the-wall.
• Never repeat the same activity venue across days. Vary neighborhoods — Plaza one day, Railyard another, Tesuque another.

FLIGHTS — ACCURACY OVER SPECIFICITY, PREFER NONSTOP, ALWAYS STRUCTURED:
• Every Flight item MUST include a "flight" object with: carrier, from_airport (IATA), to_airport (IATA), depart_time (rough window OK), arrive_time (rough window OK), duration, nonstop (boolean), cabin, aircraft, confirmation_note. Do NOT include flight_number — the app handles flight-number lookup for the user.
• CARRIER SELECTION — DO THIS FIRST: name a carrier you are HIGHLY CONFIDENT actually operates a nonstop on this exact city pair. If you cannot name one with confidence, leave carrier as a comma-separated short list of candidates (e.g. "SAS or Delta") and add a flags[] entry like "Verify which carrier operates nonstop — candidates: SAS, Delta". Do NOT invent a carrier that doesn't fly the route.
• FLIGHT NUMBERS — DO NOT EMIT. The app strips any flight_number you send and renders a "Look up actual flight" link instead. Set "flight_number": null. The user looks up the real flight on Google Flights, not from your output. Do NOT make up numbers like "UA 1234" — they will be removed but they waste tokens and erode trust if anyone sees the raw JSON.
• ROUTE TRUTH — common transatlantic / long-haul nonstops you MUST get right:
   - EWR ↔ CPH: SAS operates the daily nonstop. United sells the route only as codeshare/connecting (via FRA, MUC, ZRH). Do NOT emit "United nonstop EWR-CPH".
   - JFK ↔ CPH: SAS and Norse Atlantic. Delta connects.
   - EWR ↔ ZRH: United and Swiss both operate nonstop daily.
   - JFK ↔ ZRH: Swiss and Delta operate nonstop.
   - EWR/JFK ↔ LHR: BA, United (EWR), Virgin Atlantic, American (JFK), Delta (JFK) all run nonstops.
   - JFK ↔ CDG: Air France, Delta, American operate nonstop.
   - EWR ↔ CDG: United and Air France nonstop.
   - EWR/JFK ↔ FRA: Lufthansa, United (EWR), Singapore (JFK via FRA).
   - JFK ↔ NRT/HND: ANA, JAL, Delta (HND), American (HND).
   - LAX ↔ NRT/HND: ANA, JAL, Delta, American, United.
  If the user's route is NOT in this list and you're unsure, list 2–3 candidate carriers in flags[] and DO NOT invent a single specific carrier.
• Every confirmation_note MUST literally end with this exact sentence: "Verify flight number, times and equipment at booking — schedules change." Copy it verbatim; do not paraphrase.
• WRONG confirmation_note: "Book directly on united.com for Polaris lounge access at EWR Terminal C"
• RIGHT confirmation_note: "Book directly on united.com for Polaris lounge access at EWR Terminal C. Verify flight number, times and equipment at booking — schedules change."
• Search for nonstop service from the home airport to the destination's primary airport first.
• ARRIVAL AIRPORT — PICK THE CLOSEST VIABLE ONE, NOT THE NEAREST MAJOR HUB. For destinations with smaller regional airports, the right answer is the regional, not the metro hub the model knows best. Specifically:
   - Bar Harbor / Acadia, Maine → BHB (15 min, seasonal Cape Air/JetBlue) or BGR (50 min, year-round mainline). NOT BOS (5 h drive) and NOT PWM (3 h drive).
   - Santa Fe → SAF (15 min, limited) or ABQ (1 h, most options). NOT DEN or DFW.
   - Taos → TAOS (15 min, limited) or ABQ (2.5 h) or SAF (1.5 h).
   - Jackson Hole / Grand Teton → JAC (15 min). NOT SLC unless winter weather closure.
   - Aspen → ASE (15 min) or EGE (1 h 15) or GJT (2 h 30). NOT DEN (4 h drive).
   - Vail / Beaver Creek → EGE (45 min) or ASE (1 h 30) or DEN (2 h).
   - Sun Valley → SUN (15 min) or BOI (2 h 30).
   - Big Sky / Yellowstone → BZN (1 h) or WYS (seasonal) or JAC (south entrance).
   - Glacier National Park → GPI/FCA (30 min) or MSO (2 h 30).
   - Napa / Sonoma → STS (Santa Rosa, 45 min from Napa) or OAK (1 h) or SFO (1 h 30). Avoid SJC.
   - Martha's Vineyard → MVY (10 min) or HYA (ferry + drive) or BOS (3 h+ferry).
   - Nantucket → ACK (10 min) or HYA (ferry) or BOS (3 h+ferry).
   - Hamptons / Montauk → HTO (East Hampton, seasonal) or ISP (Long Island MacArthur, 1 h 30) or JFK (2 h 30).
   - Cape Cod → HYA (Hyannis) or PVC (Provincetown) or BOS (1 h 30–3 h).
   - Newport, Rhode Island → PVD (45 min) or BOS (1 h 30).
   - Hilton Head → HHH (15 min) or SAV (45 min). NOT CHS.
   - Savannah → SAV (15 min). NOT JAX or CHS.
   - Asheville → AVL (20 min). NOT CLT (2 h 15) and NOT GSP (1 h).
   - Charleston SC → CHS (20 min).
   - Key West → EYW (10 min) or MIA (3 h 30).
   - Park City / Deer Valley → SLC (45 min).
   - Telluride → TEX (10 min) or MTJ (1 h 15) or GJT (2 h 30) or DEN (6 h+).
   - Steamboat Springs → HDN (30 min) or DEN (3 h).
   - Hallstatt → SZG (Salzburg, 1 h 15) or VIE (3 h).
   - Interlaken → BRN (1 h) or ZRH (2 h) or GVA (2 h 30).
   - St. Moritz → ZRH (3 h) or MXP (3 h 30) or LUG (2 h).
   - Zermatt → ZRH (3 h 30 + train) or GVA (3 h 30 + train).
   - Chamonix → GVA (1 h 15) or LYS (2 h 30).
   - Reykjavik → KEF (45 min).
   - Cinque Terre → PSA (1 h) or GOA (1 h 30) or MXP (3 h 30).
   - Tuscany / Florence → FLR (20 min) or PSA (1 h 30) or BLQ (1 h 30).
   - Amalfi / Positano → NAP (1 h 15).
   - Capri → NAP (1 h 30 + ferry).
   - Sicily → CTA (Catania) or PMO (Palermo).
   - Mallorca → PMI. Ibiza → IBZ. Mykonos → JMK. Santorini → JTR.
  GENERAL RULE: when a regional airport with scheduled passenger service exists within ~1 h of the destination, prefer it over a metro hub 2–5 h away even if the hub has more flight options. Long drives erode trip time; users prefer one short drive over a savings of a couple connecting flights.
• If no nonstop exists to the requested airport but one exists to a nearby airport in the same metro (e.g., ABQ ~60min from Santa Fe instead of SAF), RECOMMEND THE NONSTOP and add a flags[] note mentioning the drive time.
• Only return a connecting itinerary if no nonstop exists to any reasonable nearby airport. Set nonstop=false and fill "connection" with the connecting airport IATA.
• In each Flight item's text, explicitly state "nonstop" or "connecting via X".
• If the user's preferred airline doesn't fly nonstop but a competitor does, mention the competitor nonstop in flags[] AND use the competitor as the carrier — do not falsely claim the preferred airline operates a nonstop it doesn't actually fly.

HOTEL ITEMS:
• Use a Hotel-type item on arrival day (check-in) and departure day (check-out). Populate the "hotel" object with name, address, phone (formatted, tappable), check_in_time, check_out_time, room_type, confirmation_note.
• The phone field is critical — it becomes a tappable "Call hotel" CTA in the app.

RESTAURANTS:
• Every Dinner/Lunch/Breakfast/Brunch item should include the full restaurant object: name, neighborhood, cuisine, price_range, why, closure_note, reservation, menu, backup.
• Be aware of the weekday for each meal. Many fine-dining spots close Mon or Tue — don't recommend a restaurant on its closure day. If unsure, put "Confirm hours — closure day uncertain" in closure_note.
• Always include a same-tier backup in the same neighborhood / cuisine family.
• reservation.platform: opentable for most US/UK/EU fine dining; resy for trendy NYC/LA/Miami; tock for tasting menus; phone with a phone number for hole-in-the-walls; walkin if no reservations. Include the canonical url when you know it.
• menu schema: { style_note, signature_dishes, appetizers, mains, desserts, wine_and_drinks, source_note }. Real dishes the restaurant is actually known for. Always include the source_note acknowledging menus change.

LOGISTICS chips:
• Short chips only — max 6, each ≤40 chars. Top-line facts only (airline summary, hotel name, car). DO NOT write sentences here. The full plan goes in days[].

WEATHER WINDOW (top-level):
• 1–2 sentences on the SEASONAL pattern for the destination during these dates. Include any planning-relevant pattern (monsoon afternoons, midday heat, fog, ski conditions, etc.). NEVER claim a live forecast.

PACK (top-level):
• 4–8 non-obvious essentials specific to this destination/season (altitude meds, layers, cash for cash-only spots, sun protection, charging adapters for region). Skip obvious items.

PLAN B (top-level, ≥5 entries):
• Cover: weather/rain, sold-out marquee restaurant, closed-day activity substitute, transport disruption (canceled flight or rental car issue), health/altitude/illness day, and any destination-specific risk.

TONIGHT (top-level):
• Prefix each action: '⚠︎ Must today:' for things that lose value if delayed (sold-out restaurants, advance-only tours), '· This week:' for important but flexible, 'Anytime:' for low-urgency. Order most-urgent first.

TONE: Insider, opinionated, specific. Real names, real dishes, real neighborhood detail. Avoid travel-blog vagueness.`;
  };

  const buildUserPrompt = () => {
    const active = Object.entries(outputs).filter(([, v]) => v).map(([k]) => k).join(", ");
    const cityLine = isMultiCity
      ? `Route: ${cities.map((c, i) => `${i + 1}) ${c.name} — ${c.nights} nights`).join("  →  ")}`
      : `Destination: ${basics.destination}`;
    return `Plan this trip:
${cityLine}
Base area: ${basics.baseArea || (isMultiCity ? "—" : "suggest best area")}
Start date: ${formatDateForDisplay(basics.startDate) || basics.startDate}
Nights: ${isMultiCity ? totalNightsFromCities : basics.nights}${isMultiCity ? "  (" + cities.map(c => `${c.nights} in ${c.name}`).join(" + ") + ")" : ""}
Travelers: ${basics.travelers}
Style: ${prefToText(basics.style)} · Pace: ${basics.pace || "No preference"} · Budget: ${basics.budget || "No preference"}
${flights.noFlight ? `Transportation mode: GROUND ONLY (driving / train). No flights. Do NOT emit any Flight items. Day 1 arrival is a Transport item describing the drive or rail journey from the user's origin to the destination, with realistic time + distance.` : `Home airport: ${flights.homeAirport} · Airline: ${flights.airline || "no preference"} · Cabin: ${flights.cabin || "no preference"}`}
Hotel brand: ${prefToText(hotel.brand)}${hotel.tier ? ` · ${hotel.tier}` : ""} · Must-haves: ${hotel.mustHave || "none"}
Transport: ${prefToText(transport.type)}${transport.company ? ` · ${transport.company}` : ""}
Cuisine: ${dining.cuisine || "local"} · Dinner budget: ${prefToText(dining.budget)}
Restaurants requested: ${restaurants.length ? restaurants.join(", ") : "suggest"}
Activities requested: ${activities.length ? activities.join(", ") : "suggest based on style"}
Interests: ${interests.text || "not specified"} · Level: ${interests.level || "No preference"}
Include sections: ${active}

${flights.noFlight ? `IMPORTANT: NO FLIGHTS. The user is driving or taking the train. Day 1 must be a Transport item describing the surface-travel arrival; do not invent flights, do not include any Flight items in days[].items.` : `IMPORTANT: Prefer NONSTOP flights. If ${flights.homeAirport} has no nonstop to the primary airport for ${isMultiCity ? cities[0]?.name : basics.destination}, recommend a nearby airport that does have nonstop service and note the drive time. The user does NOT want a connecting itinerary if a nonstop exists to any nearby airport.`}
IMPORTANT: Return a complete days[] array with ${(isMultiCity ? totalNightsFromCities : (parseInt(basics.nights,10)||3)) + 1} entries (arrival day + ${isMultiCity ? totalNightsFromCities : (parseInt(basics.nights,10)||3)} nights). Do not collapse the plan into the logistics chip list.${isMultiCity ? `
IMPORTANT: This is a ${cities.length}-city trip. Emit cities[] with ${cities.length} entries. Each day's "city" field must match a city in cities[] (or use From→To format for transit days). Inter-city transit is a Transport item at the start of legs 2+ with realistic drive time + distance.` : ""}
IMPORTANT: Write days[] BEFORE logistics, flags, planb, snobs, or tonight. days[] comes immediately after destination + meta in the tool input.
IMPORTANT: NO RESTAURANT MAY APPEAR TWICE. Each named restaurant gets ONE meal slot across the entire trip. Vary breakfasts — use real local spots, not the hotel restaurant on repeat.
IMPORTANT: Each day MUST have a "headline" (the one signature moment) and a "weather" line (seasonal expectation). Top-level MUST include weather_window, pack[≥3], planb[≥5], tonight (with priority prefixes).`;
  };

  // Active-job storage key. When a build is in flight we write the jobId and
  // form snapshot here so a reopened window can re-attach to the server-side
  // job and continue polling exactly where it left off. Cleared on completion,
  // explicit cancel, or hard error.
  const ACTIVE_JOB_KEY = "trip-optimizer-active-job-v1";

  // Read NDJSON lines from a streaming Response body. Calls onJob with the
  // jobId as soon as it lands, then onDelta with each text chunk, then
  // resolves with the final accumulated length when {"type":"done"} arrives.
  // Throws on {"type":"error"} or transport error. This is the FAST PATH:
  // when the client stays connected to the POST, we get deltas with zero
  // KV-poll latency. If the connection breaks (network blip, mobile sleep)
  // the caller falls back to pollJob() against KV.
  const streamBuildResponse = async ({ resp, signal, onJob, onDelta }) => {
    if (!resp.body) throw new Error("Server did not return a stream body.");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let totalLen = 0;
    try {
      while (true) {
        if (signal?.aborted) {
          try { await reader.cancel(); } catch {}
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // NDJSON: each event is a single line terminated with \n.
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "job" && evt.jobId) {
            if (onJob) onJob(evt.jobId);
          } else if (evt.type === "delta" && evt.text) {
            totalLen += evt.text.length;
            onDelta(evt.text, totalLen);
          } else if (evt.type === "done") {
            return { len: evt.len ?? totalLen };
          } else if (evt.type === "error") {
            throw new Error(evt.error || "Build failed on server.");
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    // Stream ended without an explicit done — treat as soft EOF; caller can
    // fall back to polling KV.
    return { len: totalLen, softEnd: true };
  };

  // Shared poller used by both fresh builds and the resume-on-mount path.
  // Polls GET /api/build/<jobId>?cursor=N, appends server-side deltas to a
  // running toolJson buffer, updates progress, and resolves with the final
  // accumulated text when status flips to "done". Throws on "error" or
  // notFound. The signal cancels the poll loop without killing the
  // server-side job (build keeps running for next time).
  const pollJob = async ({ jobId, signal, onDelta, startCursor = 0 }) => {
    let cursor = startCursor;
    const POLL_MS = 1500;
    while (true) {
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      let resp;
      try {
        resp = await fetch(`/api/build/${encodeURIComponent(jobId)}?cursor=${cursor}`, {
          signal,
          headers: { "Cache-Control": "no-cache" },
        });
      } catch (netErr) {
        // Transient network blip during a poll — wait and retry. The job is
        // still running on the server; we just couldn't reach it this tick.
        if (netErr?.name === "AbortError") throw netErr;
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      if (resp.status === 404) {
        const err = new Error("Job not found or expired. Build again.");
        err.notFound = true;
        throw err;
      }
      if (!resp.ok) {
        // 5xx — surface once but keep trying a couple times before giving up.
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      const data = await resp.json();
      if (data?.error?.message) throw new Error(data.error.message);

      if (data.delta) {
        cursor = data.cursor;
        onDelta(data.delta, cursor);
      }
      if (data.status === "done") return { len: data.cursor };
      if (data.status === "error") throw new Error(data.error || "Build failed on server.");

      await new Promise(r => setTimeout(r, POLL_MS));
    }
  };

  // Compute progress label given the current accumulated toolJson. Pulled out
  // of the inner stream loop so it can run identically against polled deltas
  // and against a resumed job's pre-existing buffer.
  //
  // IMPORTANT: progressLabel is the *sub-line* below the bold phase header.
  // It should ONLY render when it adds detail beyond what loadingMsg (the
  // phase cycler: "Researching destination…", "Selecting hotels…",
  // "Building day-by-day itinerary…", etc.) already conveys. So we leave it
  // EMPTY for the early/placeholder states ("Starting plan…",
  // "Planning structure…") — those would just duplicate loadingMsg and
  // produce the contradictory "Starting plan… / Finalizing your plan…"
  // mismatch users have been seeing on slow builds. progressLabel only
  // fires once we have real stream content to describe ("Day 4 of 8 ·
  // dining", "Insider notes & Plan B…").
  const updateProgressLabel = (toolJson, totalDays) => {
    const dayMatches = toolJson.match(/"label"\s*:\s*"/g) || [];
    const daysSeen = dayMatches.length;
    const restaurantMatches = toolJson.match(/"reservation"\s*:/g) || [];
    const restaurantsDone = restaurantMatches.length;

    if (daysSeen === 0) {
      // No real stream signal yet — let loadingMsg (phase cycler) own the
      // header without a competing sub-line.
      setProgressLabel("");
    } else if (daysSeen <= totalDays) {
      const currentDay = daysSeen;
      const lastLabelIdx = toolJson.lastIndexOf('"label"');
      const restIdx = toolJson.lastIndexOf('"restaurant"');
      const menuIdx = toolJson.lastIndexOf('"menu"');
      if (restaurantsDone > 0 && menuIdx > lastLabelIdx) {
        setProgressLabel(`Day ${currentDay} of ${totalDays} · menu`);
      } else if (restIdx > lastLabelIdx) {
        setProgressLabel(`Day ${currentDay} of ${totalDays} · dining`);
      } else {
        setProgressLabel(`Day ${currentDay} of ${totalDays} · activities`);
      }
    } else {
      setProgressLabel("Insider notes & Plan B…");
    }
  };

  const handleCancel = () => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} }
    // Drop the stored active job so we don't auto-resume it on next mount.
    try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
    setLoading(false);
    setLoadingMsg("");
  };

  // Internal: drive the UI state machine for a running job. Used for both
  // fresh starts (jobId just minted) and resume-on-reopen (jobId loaded from
  // localStorage). Caller provides the expected nights so progress can be
  // computed without re-deriving from current form state (which may be empty
  // on a resume into a fresh tab).
  const runBuildForJob = async ({ jobId, nightsNum, expectedTokens, startedAt, citiesCount = 1, streamResp = null, onJobIdReady = null }) => {
    setLoading(true);
    setError("");
    setProgress(0);
    setProgressLabel("");
    setElapsedSec(0);
    setLoadingMsg("Researching destination…");

    const totalDays = nightsNum + 1;
    // Build-time scales with trip size. A single-city 3-night plan finishes in
    // ~2.5 min; a 3-city 9-night plan needs ~5-6 min because the model emits
    // many more days, hotels, transit legs, and restaurants.
    const targetSec = Math.round(120 + totalDays * 12 + Math.max(0, citiesCount - 1) * 60);
    let lastTokenFrac = 0;

    const elapsedTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSec(sec);
      const timeFrac = Math.min(0.95, sec / targetSec);
      const frac = Math.max(lastTokenFrac, timeFrac);
      setProgress(prev => (prev >= 1 ? prev : Math.max(prev, frac)));
    }, 250);

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

    // The client-side hard timeout has to outlast the server build for any
    // trip size. Single-city ~5 min; multi-city scales up. The server keeps
    // running independently — we just stop polling if we hit the ceiling.
    const controller = new AbortController();
    abortRef.current = controller;
    const hardTimeoutMs = Math.max(300000, targetSec * 1000 * 3); // 3× the target, floor 5 min
    const hardTimeout = setTimeout(() => controller.abort(new Error("Polled too long")), hardTimeoutMs);

    // "Still building" notice scales with expected build time so we don't
    // claim a 3-city plan is slow at 90s when 4-5 min is normal.
    const slowNoticeMs = Math.max(90000, Math.round(targetSec * 1000 * 0.75));
    const typicalMin = Math.max(2, Math.round(targetSec / 60));
    const typicalRange = citiesCount > 1 ? `${typicalMin}–${typicalMin + 2} minutes` : "2–3 minutes";
    const slowNotice = setTimeout(() => {
      setLoadingMsg(prev => prev.includes("still building") ? prev : `Still building — detailed plans typically take ${typicalRange}…`);
    }, slowNoticeMs);

    // Wake lock keeps the screen alive on iOS so polling stays fluid; with
    // server-side jobs even a screen sleep no longer kills the build, but a
    // bright phone keeps the polling visible.
    let wakeLock = null;
    const requestWakeLock = async () => {
      try {
        if ("wakeLock" in navigator && navigator.wakeLock?.request) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch {}
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && abortRef.current === controller) {
        requestWakeLock();
      }
    };
    await requestWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    let toolJson = "";
    const onDelta = (delta /*, totalLen */) => {
      toolJson += delta;
      const estTokens = toolJson.length / 3.5;
      const tokFrac = Math.min(0.95, estTokens / expectedTokens);
      lastTokenFrac = tokFrac;
      setProgress(prev => Math.max(prev, tokFrac));
      updateProgressLabel(toolJson, totalDays);
    };

    try {
      // Primary path: read the open POST stream (zero-latency deltas, no 30s
      // waitUntil ceiling because the client is the lifeline). Falls back to
      // KV polling if the connection drops mid-build.
      let needPollFallback = !streamResp;
      let resolvedJobId = jobId;
      if (streamResp) {
        try {
          const out = await streamBuildResponse({
            resp: streamResp,
            signal: controller.signal,
            onJob: (id) => {
              resolvedJobId = id;
              if (onJobIdReady) onJobIdReady(id);
            },
            onDelta,
          });
          if (out.softEnd) needPollFallback = true;
        } catch (streamErr) {
          if (streamErr?.name === "AbortError") throw streamErr;
          // Network drop during stream — keep what we have and resume via KV.
          needPollFallback = true;
        }
      }
      if (needPollFallback) {
        if (!resolvedJobId) {
          // Connection died before the server even sent the jobId. Nothing
          // to resume from in KV.
          throw new Error("Lost connection to server before build started. Tap Build again.");
        }
        // toolJson may already hold partial bytes from the stream — tell the
        // poller our cursor so it doesn't re-deliver them.
        await pollJob({
          jobId: resolvedJobId,
          signal: controller.signal,
          onDelta,
          startCursor: toolJson.length,
        });
      }

      setProgress(1);
      setProgressLabel("Finalizing…");

      if (!toolJson) throw new Error("No content returned from AI service.");

      let parsed;
      try {
        parsed = JSON.parse(toolJson);
      } catch (parseErr) {
        const salvaged = salvageTruncatedJSON(toolJson);
        if (salvaged) {
          try {
            parsed = JSON.parse(salvaged);
            parsed._truncated = true;
          } catch (salvageErr) {
            throw new Error("The plan was cut off before it finished. Try again.", { cause: salvageErr });
          }
        } else {
          throw new Error("The plan was cut off before it finished. Try again.", { cause: parseErr });
        }
      }

      const expectedDays = nightsNum + 1;
      const gotDays = Array.isArray(parsed?.days) ? parsed.days.length : 0;
      if (gotDays === 0) {
        const keys = parsed ? Object.keys(parsed).join(", ") : "(no object)";
        const truncFlag = parsed?._truncated ? " [truncated]" : "";
        const buildId = (typeof __BUILD_ID__ !== "undefined") ? __BUILD_ID__ : "unknown";
        throw new Error(`No day-by-day plan returned (build ${buildId}${truncFlag}). Got keys: ${keys}. Tap Build again.`);
      }
      if (gotDays < Math.max(2, expectedDays - 1) && !parsed._truncated) {
        parsed._dayCountWarning = `Expected ~${expectedDays} days, got ${gotDays}`;
      }

      // Success — clear the stored active job so we don't auto-resume it.
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      // Fresh build is a brand-new plan, not yet saved — reset associations.
      setCurrentSavedTripId(null);
      setReviewState(null);
      setResult(parsed);
      setStep(3);
    } catch (err) {
      let msg;
      if (err?.name === "AbortError") {
        msg = "Build cancelled. The server may still be finishing — reopen the page within a few minutes to resume.";
      } else if (err?.notFound) {
        msg = "That build expired or was not found. Tap Build again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      } else {
        msg = err?.message || "Something went wrong generating the plan. Please try again.";
        try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      }
      setError(msg);
    } finally {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      try { if (wakeLock) await wakeLock.release(); } catch {}
      clearInterval(phaseTimer);
      clearInterval(elapsedTimer);
      clearTimeout(hardTimeout);
      clearTimeout(slowNotice);
      abortRef.current = null;
      setLoading(false);
      setLoadingMsg("");
      setProgress(0);
      setProgressLabel("");
      setElapsedSec(0);
    }
  };

  const handleBuild = async () => {
    // Estimate plan size for the progress-bar token model. For multi-city the
    // user puts nights per leg (basics.nights stays empty) so we must derive
    // the true total from cities[] — otherwise progress caps at the wrong
    // ceiling and we under-budget the timeout.
    const totalNightsBuild = isMultiCity
      ? cities.reduce((sum, c) => sum + (parseInt(c?.nights, 10) || 0), 0)
      : (parseInt(basics.nights || "3", 10) || 3);
    const nightsNum = Math.max(1, totalNightsBuild);
    const citiesCount = isMultiCity ? cities.length : 1;
    // Multi-city plans add inter-city legs, more hotels, more restaurants —
    // budget extra tokens per additional city so progress doesn't peg at 95%.
    const expectedTokens = 1200 + (nightsNum + 1) * 1300 + Math.max(0, citiesCount - 1) * 1500;

    // Build the Anthropic request body once and ship it to the server. The
    // server stores it under a jobId, returns immediately, and runs the
    // Anthropic stream in the background using waitUntil so the build
    // survives a window close, tab close, screen sleep, or network drop.
    //
    // max_tokens scales with trip size. A 3-night plan only needs ~7–9k
    // tokens; capping at 32000 means the model keeps generating long after
    // the plan is complete (more days, more restaurants, more insider notes
    // than asked for), which is why short trips were taking 3–4 minutes.
    // 2200 tokens/day + 4000 base + 1500/extra-city gives generous headroom
    // without letting the model wander.
    const maxTokensForTrip = Math.min(
      32000,
      Math.max(8000, 4000 + (nightsNum + 1) * 2200 + Math.max(0, citiesCount - 1) * 1500),
    );
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: maxTokensForTrip,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt() }],
      tools: [TRIP_PLAN_TOOL],
      tool_choice: { type: "tool", name: "submit_trip_plan" },
    };

    setLoading(true);
    setError("");
    setLoadingMsg("Starting build…");

    // Open the streaming POST. The server now returns an NDJSON body whose
    // FIRST line is {"type":"job","jobId":"..."} so we read just enough to
    // capture the jobId, persist it for resume, and then hand the same
    // open response to runBuildForJob which reads the remaining deltas.
    let streamResp;
    let jobId;
    let startedAt;
    try {
      streamResp = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!streamResp.ok) {
        const txt = await streamResp.text();
        let msg = `Could not start build (HTTP ${streamResp.status}).`;
        try { const j = JSON.parse(txt); msg = j?.error?.message || msg; } catch { if (txt) msg = txt.slice(0, 240); }
        throw new Error(msg);
      }
      // Peek the first NDJSON line via a tee'd reader so runBuildForJob can
      // still consume the full body. Simpler: read the head ourselves and
      // pre-prime toolJson via a small jobOnly handler. We use a one-shot
      // reader that grabs lines until we see the job event, then we pass the
      // SAME reader-bound body to the streamer by reading the underlying
      // body's reader via a TransformStream pipe. Implementation: use a
      // Response/ReadableStream split.
      //
      // Implementation chosen for simplicity: read the body ourselves in
      // streamBuildResponse() from inside runBuildForJob and use the
      // onJob callback to capture the jobId.
      startedAt = Date.now();
    } catch (err) {
      setError(err?.message || "Could not start build. Please try again.");
      setLoading(false);
      setLoadingMsg("");
      return;
    }

    // We need the jobId for the localStorage active-job key before we hand
    // the response off to runBuildForJob. Read just the first line here.
    // streamBuildResponse() inside runBuildForJob will continue from the
    // remaining bytes (the TextDecoder buffer is per-reader so we keep one).
    //
    // To keep this simple and robust, runBuildForJob accepts the open
    // response and calls streamBuildResponse with an onJob callback that
    // writes localStorage as soon as the jobId lands.
    await runBuildForJob({
      jobId: null,
      nightsNum,
      expectedTokens,
      startedAt,
      citiesCount,
      streamResp,
      onJobIdReady: (id) => {
        try {
          localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({
            jobId: id,
            startedAt,
            nightsNum,
            expectedTokens,
            citiesCount,
            destination: basics.destination || (basics.cities?.[0]?.name) || "your trip",
          }));
        } catch {}
      },
    });
  };

  // Resume an in-flight build if the user reopens the page during one. We
  // store the jobId + a few stats in localStorage when a build starts; if we
  // find a fresh one here on mount, re-attach to its server-side stream. The
  // build kept running on Cloudflare while the page was gone (waitUntil) —
  // we just rejoin the polling loop and pick up wherever the server is now.
  // Stale jobs (>30 min) are discarded so we don't poll into 404s forever.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    let raw;
    try { raw = localStorage.getItem(ACTIVE_JOB_KEY); } catch { return; }
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch { return; }
    if (!saved?.jobId) return;
    const age = Date.now() - (saved.startedAt || 0);
    if (age > 30 * 60 * 1000) {
      try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
      return;
    }
    // Probe the job first so we don't show a spinner for an expired/missing one.
    // ONLY resume if the server says the build is still running. If status is
    // 'done' or 'error' (e.g. previous timeout / partial completion), clear
    // the key and stay on the home page — the user already navigated away
    // and we shouldn't force them back into a stuck build screen.
    fetch(`/api/build/${encodeURIComponent(saved.jobId)}?cursor=0`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || data.notFound || data?.status !== "running") {
          try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
          return;
        }
        setStep(2);
        setLoadingMsg(`Resuming build for ${saved.destination || "your trip"}…`);
        runBuildForJob({
          jobId: saved.jobId,
          nightsNum: saved.nightsNum || 3,
          expectedTokens: saved.expectedTokens || 6500,
          startedAt: saved.startedAt || Date.now(),
          citiesCount: saved.citiesCount || 1,
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Called by ReviewPanel when the user applies revisions and we have a new
  // plan (either surgically patched or fully re-planned). We replace the
  // displayed result and, if this plan came from a saved trip entry, also
  // persist the new plan into that entry so re-opening preserves the edits.
  const handlePlanRevised = (newPlan) => {
    if (!newPlan) return;
    // Carry over any pre-existing _review marker; ReviewPanel will overwrite
    // it shortly via onReviewChange.
    const merged = reviewState ? { ...newPlan, _review: reviewState } : newPlan;
    setResult(merged);
    if (currentSavedTripId) {
      const list = loadSavedTrips();
      const next = list.map(t => t.id === currentSavedTripId ? { ...t, result: merged } : t);
      writeSavedTrips(next);
      refreshSavedTrips();
    }
  };

  // Called by ReviewPanel whenever review state changes (sources/findings/
  // applied_ids). We attach it to the current result as _review and persist
  // back into the saved-trip entry if we have one.
  const handleReviewChange = (next) => {
    setReviewState(next);
    setResult(prev => prev ? { ...prev, _review: next } : prev);
    if (currentSavedTripId) {
      const list = loadSavedTrips();
      const updated = list.map(t => {
        if (t.id !== currentSavedTripId) return t;
        return { ...t, result: { ...t.result, _review: next } };
      });
      writeSavedTrips(updated);
      refreshSavedTrips();
    }
  };

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
            <Fragment key={s}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: step >= i + 1 ? GOLD : "var(--color-border-secondary)", display: "inline-block", flexShrink: 0 }} />
              <span style={{ color: step >= i + 1 ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>{s}</span>
              {i < 2 && <span style={{ color: "var(--color-border-secondary)", margin: "0 2px" }}>·</span>}
            </Fragment>
          ))}
        </div>

        {step === 1 && (
          <div>
            <SavedTripsPanel trips={savedTrips} onOpen={handleOpenSavedTrip} onDelete={handleDeleteSavedTrip} />
            <StaleChipsBanner suggestion={staleSuggestion} onClear={clearStaleChips} onDismiss={dismissStale} />
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "1.5rem", lineHeight: "1.65" }}>Four essentials to start. Refine the details after, or build immediately.</p>

            <div style={cardStyle}>
              <p style={ctStyle}>Where & when</p>
              <div style={g2}>
                {/* When multi-city, Trip Route needs the full row width or the city
                    input collapses to zero. Span both grid columns; Home airport
                    wraps to the next row below. */}
                <div style={{ gridColumn: isMultiCity ? "1 / -1" : "auto", minWidth: 0 }}>
                <Field label={isMultiCity ? "Trip route" : "Destination"} hint={isMultiCity ? `${cities.length}-city trip · ${totalNightsFromCities} nights total` : null}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {cities.map((c, i) => (
                      <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                        {isMultiCity && (
                          <span style={{ fontSize: "9.5px", fontWeight: 700, color: GOLD, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 0 0", whiteSpace: "nowrap", flex: "0 0 auto" }}>Leg {i + 1}</span>
                        )}
                        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                          <CityAutocomplete value={c.name} onChange={e => updateCity(i, { name: e.target.value })} placeholder={i === 0 ? "Start typing a city…" : "Next city…"} />
                        </div>
                        {isMultiCity && (
                          <div style={{ flex: "0 0 64px" }}>
                            <input type="number" min="1" max="14" value={c.nights} onChange={e => updateCity(i, { nights: e.target.value })} placeholder="nights" aria-label={`Nights in ${c.name || `city ${i + 1}`}`} style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", textAlign: "center" }} />
                          </div>
                        )}
                        {isMultiCity && cities.length > 1 && (
                          <button onClick={() => removeCity(i)} aria-label={`Remove ${c.name || `city ${i + 1}`}`} style={{ background: "none", border: "none", color: "var(--color-text-tertiary)", fontSize: "20px", cursor: "pointer", padding: "4px 4px", lineHeight: 1, flex: "0 0 auto" }}>×</button>
                        )}
                      </div>
                    ))}
                    {cities.length < 3 && (
                      <button onClick={addCity} style={{ background: "none", border: `0.5px dashed ${GOLD}`, color: GOLD, fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", padding: "7px 10px", borderRadius: "4px", cursor: "pointer", alignSelf: "flex-start", fontFamily: "inherit" }}>+ Add city{cities.length === 1 ? " (multi-city trip)" : ""}</button>
                    )}
                  </div>
                </Field>
                </div>
                <Field label="Home airport" hint={flights.noFlight ? "Not flying — skip this" : (lookupAirport(flights.homeAirport) ? `${lookupAirport(flights.homeAirport).city} · ${lookupAirport(flights.homeAirport).name}` : null)}>
                  {flights.noFlight ? (
                    <div style={{ height: "38px", lineHeight: "38px", borderBottom: "0.5px solid var(--color-border-secondary)", fontSize: "14px", color: "var(--color-text-secondary)", fontStyle: "italic", opacity: 0.6 }}>Not flying</div>
                  ) : (
                    <AirportAutocomplete value={flights.homeAirport} onChange={e => setF({ ...flights, homeAirport: e.target.value })} placeholder="e.g. EWR" />
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "6px", fontSize: "11px", color: "var(--color-text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>
                    <input type="checkbox" checked={!!flights.noFlight} onChange={e => setF({ ...flights, noFlight: e.target.checked, homeAirport: e.target.checked ? "" : flights.homeAirport, airline: e.target.checked ? "" : flights.airline, cabin: e.target.checked ? "" : flights.cabin })} style={{ accentColor: GOLD, margin: 0, cursor: "pointer" }} />
                    <span>Not flying (driving / train)</span>
                  </label>
                </Field>
              </div>
              <div style={g3}>
                <Field label="Start date"><DateInput value={basics.startDate} onChange={e => setB({ ...basics, startDate: e.target.value })} /></Field>
                <Field label={isMultiCity ? "Total nights" : "Nights"} hint={isMultiCity ? "Auto-summed from cities" : null}>
                  <Inp value={isMultiCity ? String(totalNightsFromCities) : basics.nights} onChange={e => { if (isMultiCity) return; const v = e.target.value; setB({ ...basics, nights: v, cities: (basics.cities && basics.cities.length > 0) ? basics.cities.map((c, i) => i === 0 ? { ...c, nights: v } : c) : [{ name: basics.destination || "", nights: v, focus: "" }] }); }} placeholder="7" />
                </Field>
                <Field label="Travelers"><TravelersAutocomplete value={basics.travelers} onChange={e => setB({ ...basics, travelers: e.target.value })} placeholder="2 adults" /></Field>
              </div>
              {!isMultiCity && (
                <Field label="Base area or neighborhood" hint={areaHint}>
                  <BaseAreaAutocomplete value={basics.baseArea} onChange={e => setB({ ...basics, baseArea: e.target.value })} placeholder="Where in the destination?" destination={basics.destination} />
                </Field>
              )}
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
            <StaleChipsBanner suggestion={staleSuggestion} onClear={clearStaleChips} onDismiss={dismissStale} />
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "1.5rem", lineHeight: "1.65" }}>Fill in what you know. Leave anything blank and the planner will suggest.</p>

            <div style={cardStyle}>
              <p style={ctStyle}>Trip style</p>
              <Field label="Style" hint="Tap one or more"><Sel multi value={basics.style} onChange={e => setB({ ...basics, style: e.target.value })} opts={["Cultural / sightseeing","Golf / sport","Food & wine","Beach / relaxation","Adventure / outdoor","Mixed"]} /></Field>
              <div style={{ ...g2, marginTop: "16px" }}>
                <Field label="Pace"><Sel value={basics.pace} onChange={e => setB({ ...basics, pace: e.target.value })} opts={["Relaxed (1–2 things/day)","Moderate (2–3 things/day)","Full (3–4 things/day)"]} /></Field>
                <Field label="Budget"><Sel value={basics.budget} onChange={e => setB({ ...basics, budget: e.target.value })} opts={["$$ — value","$$$ — mid range","$$$$ — luxury","$$$$$ — ultra high end"]} /></Field>
              </div>
            </div>

            {!flights.noFlight && (
              <div style={cardStyle}>
                <p style={ctStyle}>Flights</p>
                <div style={g3}>
                  <Field label="Preferred airline"><AirlineAutocomplete value={flights.airline} onChange={e => setF({ ...flights, airline: e.target.value })} placeholder="e.g. United" /></Field>
                  <Field label="Cabin"><Sel value={flights.cabin} onChange={e => setF({ ...flights, cabin: e.target.value })} opts={["Business / Polaris","Premium economy","Economy"]} /></Field>
                  <Field label="Date flexibility"><Sel value={flights.flex} onChange={e => setF({ ...flights, flex: e.target.value })} opts={["Exact date only","± 1 day","± 2 days"]} /></Field>
                </div>
              </div>
            )}

            <div style={cardStyle}>
              <p style={ctStyle}>Hotel</p>
              <Field label="Brand family" hint="Tap one or more"><Sel multi value={hotel.brand} onChange={e => setH({ ...hotel, brand: e.target.value })} opts={["Marriott / Bonvoy","Hilton Honors","Hyatt","IHG","Four Seasons","Ritz-Carlton","Aman","Independent / boutique"]} /></Field>
              <div style={{ marginTop: "16px" }}>
                <Field label="Sub-brand or tier"><HotelTierAutocomplete value={hotel.tier} onChange={e => setH({ ...hotel, tier: e.target.value })} placeholder="e.g. Ritz-Carlton, W, Autograph" /></Field>
              </div>
              <Field label="Must-haves"><HotelMustHaveAutocomplete value={hotel.mustHave} onChange={e => setH({ ...hotel, mustHave: e.target.value })} placeholder="e.g. pool, walkable to dining" /></Field>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Ground transport</p>
              <Field label="Type" hint="Tap one or more"><Sel multi value={transport.type} onChange={e => setT({ ...transport, type: e.target.value })} opts={["Rental car","Private driver","Rideshare / taxi","Train / rail","No car needed"]} /></Field>
              <div style={{ ...g2, marginTop: "16px" }}>
                <Field label="Preferred company"><RentalCompanyAutocomplete value={transport.company} onChange={e => setT({ ...transport, company: e.target.value })} placeholder="e.g. Hertz, Sixt" airport={flights.homeAirport} /></Field>
                <Field label="Vehicle type"><VehicleAutocomplete value={transport.vehicle} onChange={e => setT({ ...transport, vehicle: e.target.value })} placeholder="e.g. SUV, sedan" /></Field>
              </div>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Dining</p>
              <div style={g2}>
                <Field label="Cuisine preferences"><CuisineAutocomplete value={dining.cuisine} onChange={e => setD({ ...dining, cuisine: e.target.value })} placeholder="e.g. local, seafood, wine-focused" /></Field>
                <Field label="Per-dinner budget" hint="Tap one or more"><Sel multi value={dining.budget} onChange={e => setD({ ...dining, budget: e.target.value })} opts={["$$ — casual ($30–60pp)","$$$ — mid ($60–120pp)","$$$$ — fine dining ($120pp+)"]} /></Field>
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
                    {/* Single source of truth: stream-driven progressLabel wins
                       whenever it has real content ("Day 4 of 8 · dining",
                       "Insider notes & Plan B…"). Otherwise fall back to the
                       phase cycler (loadingMsg). progressLabel is intentionally
                       blank for placeholder states so we never show two
                       contradictory strings simultaneously. */}
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
                {/* Sub-line: show loadingMsg (phase) only when progressLabel is
                   driving the header. That way the user always sees BOTH the
                   data-driven detail ("Day 4 of 8 · dining") AND the broader
                   phase context ("Picking restaurants…"), but never two
                   conflicting versions of the same thing. */}
                {progressLabel && loadingMsg && progressLabel !== loadingMsg && (
                  <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "6px 0 0" }}>{loadingMsg}</p>
                )}
              </div>
            )}
            {error && <p style={{ fontSize: "12px", color: "var(--color-text-danger, #c0392b)", marginTop: "8px", textAlign: "center" }}>{error}</p>}
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "10px", textAlign: "center", fontStyle: "italic" }}>{isMultiCity && cities.length >= 3 ? "Typical 3‑city plan: 5–7 minutes. Stays building if you switch tabs." : isMultiCity ? "Typical multi‑city plan: 3–5 minutes. Stays building if you switch tabs." : "Typical plan: 2–3 minutes. Stays building if you switch tabs."}</p>
          </div>
        )}

        {step === 3 && result && (
          <ItineraryView
            data={result}
            inputs={{ basics, flights, hotel, transport, dining, restaurants, activities, interests, outputs }}
            onBack={() => { resetFormToBlank(); setCurrentSavedTripId(null); setReviewState(null); setStep(1); }}
            onEditTrip={() => {
              // Go back to the input form without wiping anything. The user's
              // basics/flights/hotel/transport/dining/restaurants/activities/
              // interests state is already populated (it's what built this
              // plan), so they can tweak dates/cities/etc and rebuild.
              setStep(1);
              // Smooth scroll to top so they land on the "Where & when" card.
              try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { window.scrollTo(0, 0); }
            }}
            onSaved={(entry) => { setCurrentSavedTripId(entry?.id || null); refreshSavedTrips(); }}
            savedTripId={currentSavedTripId}
            onPlanRevised={handlePlanRevised}
            onReviewChange={handleReviewChange}
            initialReview={reviewState}
          />
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
          <span style={{ marginLeft: "8px", color: "var(--color-text-tertiary)", fontSize: "10px" }}>
            · build {(typeof __BUILD_ID__ !== "undefined") ? __BUILD_ID__ : "dev"}
          </span>
        </div>

      </div>
    </div>
  );
}
