// Smoke test the vector PDF builder against a realistic plan shape.
// Writes /tmp/test-itinerary.pdf so we can manually inspect.
import { buildItineraryPdf } from "../src/pdf/itineraryPdf.js";
import fs from "node:fs";

const data = {
  destination: "Santa Fe → Taos",
  meta: "Sat–Fri · 6 nights · 2 travelers · luxury · 4+2 nights",
  cities: [
    { name: "Santa Fe, NM", nights: 4, days_range: "Day 1–Day 4", focus: "Galleries + food on Canyon Road", transport_in: "Fly EWR→ABQ · 4h 30m nonstop · then 1h drive", stay: "Rosewood Inn of the Anasazi" },
    { name: "Taos, NM", nights: 2, days_range: "Day 5–Day 6", focus: "Skiing & mountain lunches", transport_in: "Drive Santa Fe→Taos · 1h 15m · 70 miles via US-285", stay: "El Monte Sagrado" },
  ],
  days: [
    {
      label: "Day 1 · Sat Jun 7 · Arrive Santa Fe",
      city: "Santa Fe, NM",
      headline: "Sunset margaritas on the Anasazi rooftop",
      weather: "High 82°F / low 52°F · sun w/ 30% PM thunderstorm risk",
      pace_note: "easy arrival",
      items: [
        {
          time: "08:45",
          end_time: "11:20",
          type: "Flight",
          text: "Newark to Albuquerque",
          duration: "4h 35m",
          flight: {
            carrier: "United",
            flight_number: "UA 1234",
            from_airport: "EWR",
            to_airport: "ABQ",
            depart_time: "08:45",
            arrive_time: "11:20",
            duration: "4h 35m",
            nonstop: true,
            cabin: "Polaris Business",
            aircraft: "Boeing 737-900",
            confirmation_note: "Book directly on united.com for Polaris lounge access at EWR Terminal C.",
          },
        },
        {
          time: "13:00",
          type: "Transport",
          text: "Drive ABQ → Santa Fe (~1h)",
          location: "I-25 N",
          contact: {
            phone: "+1-505-555-1212",
            website: "https://www.santafechauffeur.com",
            booking_url: "https://www.santafechauffeur.com/book",
            booking_note: "Pre-book town car; meet curbside at ABQ Terminal.",
            price: "$185 one-way",
          },
        },
        {
          time: "15:00",
          type: "Hotel",
          text: "Check in — Rosewood Inn of the Anasazi",
          hotel: {
            name: "Rosewood Inn of the Anasazi",
            address: "113 Washington Ave, Santa Fe, NM 87501",
            phone: "+1-505-988-3030",
            check_in_time: "15:00",
            check_out_time: "11:00",
            room_type: "Anasazi Suite, king bed, kiva fireplace",
            confirmation_note: "Request a quiet room facing the courtyard.",
          },
        },
        {
          time: "19:30",
          type: "Dinner",
          text: "Geronimo on Canyon Road",
          why: "The benchmark for Santa Fe fine dining — chef-driven Southwestern in a 1756 adobe; book the front room, not the patio.",
          restaurant: {
            name: "Geronimo",
            cuisine: "New American / Southwestern",
            neighborhood: "Canyon Road",
            price_range: "$$$$",
            why: "Iconic; ask for the elk tenderloin.",
            reservation: { platform: "opentable", url: "https://www.opentable.com/r/geronimo-santa-fe", phone: "+1-505-982-1500" },
            backup: { name: "Sazón", cuisine: "Modern Mexican" },
          },
        },
      ],
    },
    {
      label: "Day 2 · Sun Jun 8 · Galleries & high desert",
      city: "Santa Fe, NM",
      headline: "Walk Canyon Road slowly before the galleries close",
      weather: "High 80°F / low 50°F · clear morning, monsoon PM",
      items: [
        { time: "08:00", type: "Breakfast", text: "Hotel breakfast at the Anasazi" },
        {
          time: "10:00",
          end_time: "12:30",
          type: "Activity",
          text: "Georgia O'Keeffe Museum",
          why: "Small but essential — book first slot to beat the cruise-day crowds.",
          contact: {
            phone: "+1-505-946-1000",
            website: "https://www.okeeffemuseum.org",
            booking_url: "https://www.okeeffemuseum.org/visit/tickets",
            address: "217 Johnson St, Santa Fe, NM 87501",
            hours: "Tue–Sun 10–5, closed Mondays",
            price: "$20/adult",
          },
        },
        { time: "13:30", type: "Lunch", text: "The Shed", restaurant: { name: "The Shed", cuisine: "New Mexican", why: "Red chile enchiladas — order Christmas.", reservation: { platform: "walkin" } } },
        { time: "15:30", end_time: "18:00", type: "Activity", text: "Canyon Road gallery walk",
          contact: { website: "https://www.visitcanyonroad.com", address: "Canyon Rd, Santa Fe, NM" } },
        { time: "20:00", type: "Dinner", text: "Sazón", restaurant: { name: "Sazón", cuisine: "Modern Mexican", why: "Chef Fernando's mole flight is a destination dish.", reservation: { platform: "tock", url: "https://www.exploretock.com/sazonsantafe" } } },
      ],
    },
  ],
  logistics: ["Altitude 7,200 ft", "Tip 20–22%", "ABQ ~1h south", "No Uber after 11pm"],
  weather_window: "Early June in Santa Fe is dry and sunny with afternoon thunderstorm potential after 3pm — plan museums and shopping for afternoons, hikes for mornings.",
  pack: ["Aspirin for altitude headache", "Layers — evenings drop 30°F", "Cash for Canyon Road galleries", "Sunblock + wide-brim hat", "Real walking shoes — cobbles"],
  flags: ["O'Keeffe Museum closed Mondays", "Geronimo books 30+ days out for prime seating"],
  planb: [
    "If afternoon thunderstorm hits Day 2 — swap gallery walk for SITE Santa Fe + IAIA Museum (indoor).",
    "If Geronimo is sold out — Sazón, Joseph's, or the bar menu at La Boca.",
    "Altitude headache Day 1 — slow pace, hydrate, Anasazi can deliver oxygen on request.",
    "If UA1234 cancels — DL operates 2x daily JFK→ABQ; Anasazi will hold check-in.",
    "If skiing is closed Day 5 — drive the High Road to Taos via Chimayó & Truchas.",
  ],
  snobs: [
    "Skip the Plaza after 11am — go before 9am or after 6pm for the actual feel.",
    "Real locals drink at Secreto Lounge or the Coyote Cantina rooftop, not the hotel.",
  ],
  tonight: [
    "⚠︎ Must today: Book Geronimo on OpenTable for Day 1 at 19:30.",
    "· This week: Reserve O'Keeffe tickets for Day 2 first slot.",
    "Anytime: Pre-book ABQ→Santa Fe town car.",
  ],
};

const inputs = {
  basics: { destination: "Santa Fe, NM + Taos, NM", cities: data.cities, startDate: "2026-06-07", nights: 6, travelers: 2, style: "Luxury / editorial", pace: "Moderate", budget: "$15k+", baseArea: "Plaza district" },
  flights: { homeAirport: "EWR", airline: "United", cabin: "Polaris Business", flex: "±1 day" },
  hotel: { brand: "Rosewood / Auberge / boutique", tier: "5-star", mustHave: "Walking distance to Plaza, quiet room" },
  transport: { type: "Private driver + rental for Taos", company: "Santa Fe Chauffeur", vehicle: "SUV" },
  dining: { cuisine: "New Mexican + chef-driven New American", budget: ["$$$", "$$$$"] },
  restaurants: ["Geronimo", "Sazón", "The Shed"],
  activities: ["O'Keeffe Museum", "Canyon Road", "Bandelier"],
  interests: { level: "high", text: "Art, food, and slow mornings — minimal driving, no group tours." },
  guidelines: "Two adults, 6 nights total (4 Santa Fe + 2 Taos). Polaris on UA from EWR. Luxury hotels only. Need Geronimo on Day 1.",
  narrative: "We want a slow, editorial trip — early dinners aren't us. Save energy for galleries.",
  outputs: { flights: true, lodging: true, dining: true, activities: true, essentials: true },
};

const pdf = await buildItineraryPdf(data, inputs, { buildId: "smoke" });
const buf = Buffer.from(pdf.output("arraybuffer"));
const out = "/tmp/test-itinerary.pdf";
fs.writeFileSync(out, buf);
console.log(`Wrote ${out} (${buf.length} bytes, ${pdf.getNumberOfPages()} pages)`);
