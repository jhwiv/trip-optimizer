import { useState } from "react";

const GOLD = "#C4A862";
const GOLD_LIGHT = "#F5EDD6";
const GOLD_DARK = "#A08845";

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

function DayBlock({ day }) {
  return (
    <div style={{ borderLeft: `2px solid ${GOLD}`, paddingLeft: "1rem", marginBottom: "1.5rem", borderRadius: 0 }}>
      <p style={{ fontSize: "13px", fontWeight: "600", color: "var(--color-text-primary)", margin: "0 0 10px", letterSpacing: "0.02em" }}>{day.label}</p>
      {day.items.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "7px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: "1.5" }}>
          <Badge type={item.type} />
          <span style={{ color: "var(--color-text-secondary)" }}>{item.text}</span>
        </div>
      ))}
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
  return (
    <div>
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
          {data.days.map((d, i) => <DayBlock key={i} day={d} />)}
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

function Inp({ value, onChange, placeholder }) {
  return <input value={value} onChange={onChange} placeholder={placeholder} style={{ fontSize: "14px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", lineHeight: "1.4" }} />;
}

function Sel({ value, onChange, opts }) {
  return (
    <select value={value} onChange={onChange} style={{ fontSize: "13px", padding: "9px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", width: "100%", boxSizing: "border-box", outline: "none", fontFamily: "inherit", appearance: "none", cursor: "pointer" }}>
      {opts.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

function TagInput({ placeholder, tags, setTags }) {
  const [val, setVal] = useState("");
  const add = () => { const v = val.trim(); if (v) { setTags([...tags, v]); setVal(""); } };
  return (
    <div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === "Enter" && add()} placeholder={placeholder}
          style={{ flex: 1, fontSize: "13px", padding: "8px 0", border: "none", borderBottom: "0.5px solid var(--color-border-primary)", background: "transparent", color: "var(--color-text-primary)", outline: "none", fontFamily: "inherit" }} />
        <button onClick={add} style={{ background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "6px 12px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>+ Add</button>
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
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const [basics, setB] = useState({ destination: "", startDate: "", nights: "", travelers: "2 adults", baseArea: "", style: "Mixed", pace: "Moderate (2–3 things/day)", budget: "$$$ — mid range" });
  const [flights, setF] = useState({ homeAirport: "", airline: "", cabin: "Business / Polaris", flex: "Exact date only" });
  const [hotel, setH] = useState({ brand: "Marriott / Bonvoy", tier: "", mustHave: "" });
  const [transport, setT] = useState({ type: "Rental car", company: "", vehicle: "" });
  const [dining, setD] = useState({ cuisine: "", budget: "$$$ — mid ($60–120pp)" });
  const [restaurants, setRest] = useState([]);
  const [activities, setActs] = useState([]);
  const [interests, setInt] = useState({ level: "Easy — mostly walking", text: "" });
  const [outputs, setOut] = useState({ itinerary: true, weather: true, navigation: true, logistics: true, tonight: true, menus: true, flags: true, planb: true, snobs: true, practical: false, badges: false, pronunciation: false });

  const togOut = k => setOut(o => ({ ...o, [k]: !o[k] }));
  const missing = [!basics.destination.trim() && "Destination", !basics.startDate.trim() && "Start date", !basics.nights.trim() && "Nights", !flights.homeAirport.trim() && "Home airport"].filter(Boolean);
  const ready = missing.length === 0;
  const areaHint = getAreaHint(basics.destination);
  const activeCount = Object.values(outputs).filter(Boolean).length;

  const buildSystemPrompt = () => `You are a luxury travel planner. Return ONLY valid JSON — no markdown, no backticks, no preamble.

Return this exact structure:
{
  "destination": "City, Country",
  "meta": "Dates · N nights · N travelers · Style",
  "logistics": ["Flight: EWR → LIS United Business", "Hotel: Bairro Alto Hotel", "Car: Hertz Gold SUV"],
  "days": [
    {
      "label": "Day 1 · Mon Jun 3 · Arrive Lisbon",
      "items": [
        { "type": "Flight", "text": "EWR → LIS, depart 18:40, arrive 07:05+1, United (suggested)" },
        { "type": "Hotel", "text": "Check in · Bairro Alto Hotel, Chiado" },
        { "type": "Activity", "text": "Afternoon: Baixa walk, Praça do Comércio, first impressions" },
        { "type": "Dinner", "text": "Taberna da Rua das Flores — petiscos, no reservation needed early" }
      ]
    }
  ],
  "flags": ["Sintra — book timed entry online or queues are brutal", "Pastéis de Belém opens 8am — go before 9am"],
  "planb": ["If rain on Day 3: Museu Nacional do Azulejo instead of Sintra", "If Belém crowds: LxFactory market is 10 min away"],
  "snobs": ["Say Baixa-Chiado (BI-sha SHYA-doo), not 'the downtown area'", "Pastéis de nata at Manteigaria are better than Belém. Fight me."],
  "tonight": ["Download offline maps for Sintra and Cascais — signal is poor", "Confirm Day 3 rental car pickup time", "Book Belém timed entry at patrimoniocultural.gov.pt"]
}

Generate ${basics.nights || 3} days. Be specific, opinionated, insider-toned. Real restaurant names. Real neighborhoods. Actual timing.`;

  const buildUserPrompt = () => {
    const active = Object.entries(outputs).filter(([, v]) => v).map(([k]) => k).join(", ");
    return `Plan this trip:
Destination: ${basics.destination}
Base area: ${basics.baseArea || "suggest best area"}
Start date: ${basics.startDate}
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

  const handleBuild = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: buildSystemPrompt(),
          messages: [{ role: "user", content: buildUserPrompt() }],
        }),
      });
      const data = await response.json();
      const text = data.content?.find(b => b.type === "text")?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setResult(parsed);
      setStep(3);
    } catch (err) {
      setError("Something went wrong generating the plan. Please try again.");
    } finally {
      setLoading(false);
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
                <Field label="Destination"><Inp value={basics.destination} onChange={e => setB({ ...basics, destination: e.target.value })} placeholder="e.g. Lisbon, Portugal" /></Field>
                <Field label="Home airport"><Inp value={flights.homeAirport} onChange={e => setF({ ...flights, homeAirport: e.target.value })} placeholder="e.g. EWR" /></Field>
              </div>
              <div style={g3}>
                <Field label="Start date"><Inp value={basics.startDate} onChange={e => setB({ ...basics, startDate: e.target.value })} placeholder="e.g. June 3, 2027" /></Field>
                <Field label="Nights"><Inp value={basics.nights} onChange={e => setB({ ...basics, nights: e.target.value })} placeholder="7" /></Field>
                <Field label="Travelers"><Inp value={basics.travelers} onChange={e => setB({ ...basics, travelers: e.target.value })} placeholder="2 adults" /></Field>
              </div>
              <Field label="Base area or neighborhood" hint={areaHint}>
                <Inp value={basics.baseArea} onChange={e => setB({ ...basics, baseArea: e.target.value })} placeholder="Where in the destination?" />
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
                <Field label="Preferred airline"><Inp value={flights.airline} onChange={e => setF({ ...flights, airline: e.target.value })} placeholder="e.g. United" /></Field>
                <Field label="Cabin"><Sel value={flights.cabin} onChange={e => setF({ ...flights, cabin: e.target.value })} opts={["Business / Polaris","Premium economy","Economy"]} /></Field>
                <Field label="Date flexibility"><Sel value={flights.flex} onChange={e => setF({ ...flights, flex: e.target.value })} opts={["Exact date only","± 1 day","± 2 days"]} /></Field>
              </div>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Hotel</p>
              <div style={g2}>
                <Field label="Brand family"><Sel value={hotel.brand} onChange={e => setH({ ...hotel, brand: e.target.value })} opts={["Marriott / Bonvoy","Hilton Honors","Hyatt","IHG","Independent / boutique","No preference"]} /></Field>
                <Field label="Sub-brand or tier"><Inp value={hotel.tier} onChange={e => setH({ ...hotel, tier: e.target.value })} placeholder="e.g. Ritz-Carlton, W, Autograph" /></Field>
              </div>
              <Field label="Must-haves"><Inp value={hotel.mustHave} onChange={e => setH({ ...hotel, mustHave: e.target.value })} placeholder="e.g. pool, walkable to dining, full kitchen" /></Field>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Ground transport</p>
              <div style={g3}>
                <Field label="Type"><Sel value={transport.type} onChange={e => setT({ ...transport, type: e.target.value })} opts={["Rental car","Private driver","Rideshare / taxi","Train / rail","No car needed"]} /></Field>
                <Field label="Preferred company"><Inp value={transport.company} onChange={e => setT({ ...transport, company: e.target.value })} placeholder="e.g. Hertz Gold, Sixt" /></Field>
                <Field label="Vehicle type"><Inp value={transport.vehicle} onChange={e => setT({ ...transport, vehicle: e.target.value })} placeholder="e.g. SUV, sedan" /></Field>
              </div>
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Dining</p>
              <div style={g2}>
                <Field label="Cuisine preferences"><Inp value={dining.cuisine} onChange={e => setD({ ...dining, cuisine: e.target.value })} placeholder="e.g. local, seafood, wine-focused" /></Field>
                <Field label="Per-dinner budget"><Sel value={dining.budget} onChange={e => setD({ ...dining, budget: e.target.value })} opts={["$$ — casual ($30–60pp)","$$$ — mid ($60–120pp)","$$$$ — fine dining ($120pp+)","Mixed"]} /></Field>
              </div>
              <TagInput placeholder="Add a restaurant or dining type" tags={restaurants} setTags={setRest} />
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>Activities</p>
              <div style={g2}>
                <Field label="Physical level"><Sel value={interests.level} onChange={e => setInt({ ...interests, level: e.target.value })} opts={["Easy — mostly walking","Moderate — some hiking","Active — full days on feet"]} /></Field>
                <Field label="Interests"><Inp value={interests.text} onChange={e => setInt({ ...interests, text: e.target.value })} placeholder="e.g. art, wine, architecture, golf" /></Field>
              </div>
              <TagInput placeholder="Add a specific activity" tags={activities} setTags={setActs} />
            </div>

            <div style={cardStyle}>
              <p style={ctStyle}>{`Output sections  ·  ${activeCount} of 12 active`}</p>
              {outputDefs.map(([k, l, d]) => <Toggle key={k} label={l} desc={d} checked={outputs[k]} onChange={() => togOut(k)} />)}
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "0.5rem" }}>
              <button onClick={() => setStep(1)} style={{ background: "transparent", color: "var(--color-text-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 16px", fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>← Back</button>
              <button onClick={handleBuild} disabled={loading}
                style={{ flex: 1, border: "none", borderRadius: "var(--border-radius-md)", padding: "13px 20px", fontSize: "11px", fontWeight: "500", letterSpacing: "0.1em", textTransform: "uppercase", cursor: loading ? "wait" : "pointer", fontFamily: "inherit", background: "var(--color-text-primary)", color: "var(--color-background-primary)" }}>
                {loading ? "Building your plan…" : "Build Trip Plan →"}
              </button>
            </div>
            {error && <p style={{ fontSize: "12px", color: "var(--color-text-danger, #c0392b)", marginTop: "8px", textAlign: "center" }}>{error}</p>}
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "10px", textAlign: "center", fontStyle: "italic" }}>Generates a live itinerary powered by AI</p>
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
                {[basics.baseArea, basics.startDate, basics.nights ? `${basics.nights} nights` : null, flights.homeAirport ? `from ${flights.homeAirport}` : null].filter(Boolean).join("  ·  ") || "Complete the form above"}
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
