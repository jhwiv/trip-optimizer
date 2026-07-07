// Tests for src/pdf/findPdf.js — the /find (local-info-only) PDF export.
// Builds real jsPDF documents and inspects the raw PDF bytes for embedded
// /URI link annotations (tel:, website, booking, maps) and text-stream
// content, since jsPDF doesn't expose a structured "what links did I add"
// API. This is the same verification technique used to confirm hyperlinks
// actually got embedded (not just rendered as plain text).

import { buildFindPdf } from "../src/pdf/findPdf.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗", name, detail || ""); }
}

function basePayload(overrides = {}) {
  return {
    location: "Bolton Landing, NY",
    category: "both",
    guidelines: "",
    note: "",
    restaurants: [],
    activities: [],
    localExpert: null,
    ...overrides,
  };
}

async function run() {
  console.log("test_find_pdf.mjs");

  // ---- Basic build succeeds with empty results ----
  {
    const pdf = await buildFindPdf(basePayload());
    assert("builds a PDF with 0 results", pdf.getNumberOfPages() >= 1);
  }

  // ---- Restaurant with full contact info gets live hyperlinks ----
  {
    const payload = basePayload({
      restaurants: [
        {
          name: "The Boathouse Restaurant",
          type: "Restaurant",
          cuisine: "New American",
          price_range: "$$$",
          neighborhood: "Lake Shore Drive",
          why: "Lakefront dining with sunset views over Lake George.",
          contact: {
            phone: "+1 518-555-0134",
            website: "https://www.boathouserestaurant.example",
            booking_url: "https://www.opentable.com/boathouse-example",
            address: "50 Lake Shore Dr, Bolton Landing, NY 12814",
            hours: "Daily 5-10pm",
          },
          reservation: { platform: "opentable", url: "https://www.opentable.com/boathouse-example" },
        },
      ],
    });
    const pdf = await buildFindPdf(payload, { compress: false });
    const raw = pdf.output();
    assert("restaurant name appears in PDF text stream", raw.includes("Boathouse"));
    assert("website URL is embedded as a live link", raw.includes("https://www.boathouserestaurant.example"));
    assert("booking URL is embedded as a live link", raw.includes("https://www.opentable.com/boathouse-example"));
    assert("phone is embedded as a tel: link", raw.includes("tel:+15185550134"));
    assert("address is embedded as a Google Maps link", raw.includes("https://www.google.com/maps/search/"));
    assert("PDF has link annotations", raw.includes("/Annots") && raw.includes("/URI"));
  }

  // ---- Restaurant with phone-only reservation (no online booking URL) ----
  {
    const payload = basePayload({
      restaurants: [
        {
          name: "Cate's Italian Garden",
          contact: { phone: "(518) 555-0199" },
          reservation: { platform: "phone", phone: "(518) 555-0199" },
        },
      ],
    });
    const pdf = await buildFindPdf(payload, { compress: false });
    const raw = pdf.output();
    // telUrl() strips non-digits from whatever the source provided; it does
    // not synthesize a leading '+' if the source phone string lacked one
    // (matches the shared helper's existing behavior in itineraryPdf.js).
    assert("phone-only reservation renders a tel: link", raw.includes("tel:5185550199"));
  }

  // ---- Walk-in reservation renders a label with no URL (no crash) ----
  {
    const payload = basePayload({
      restaurants: [{ name: "Frederick's Restaurant", reservation: { platform: "walkin" } }],
    });
    const pdf = await buildFindPdf(payload);
    assert("walk-in reservation builds without error", pdf.getNumberOfPages() >= 1);
  }

  // ---- Activity with contact info gets hyperlinks too ----
  {
    const payload = basePayload({
      activities: [
        {
          text: "Marcella Sembrich Opera Museum — historic lakeside music museum",
          type: "Museum",
          why: "A quiet, well-curated stop with lake views.",
          contact: {
            phone: "+1 518-555-0177",
            website: "https://www.sembrich.example",
            address: "4800 Lake Shore Dr, Bolton Landing, NY",
          },
        },
      ],
    });
    const pdf = await buildFindPdf(payload, { compress: false });
    const raw = pdf.output();
    assert("activity website is embedded as a live link", raw.includes("https://www.sembrich.example"));
    assert("activity phone is embedded as a tel: link", raw.includes("tel:+15185550177"));
    assert("activity address is embedded as a maps link", raw.includes("https://www.google.com/maps/search/"));
  }

  // ---- verify_before_booking flag renders without crashing ----
  {
    const payload = basePayload({
      restaurants: [{ name: "Chateau on the Lake", verify_status: "verify_before_booking" }],
    });
    const pdf = await buildFindPdf(payload);
    assert("verify_before_booking flag renders without error", pdf.getNumberOfPages() >= 1);
  }

  // ---- Locally sourced section only renders when localExpert has data ----
  {
    const withoutLocal = await buildFindPdf(basePayload({ restaurants: [{ name: "A" }] }), { compress: false });
    const withLocal = await buildFindPdf(basePayload({
      restaurants: [{ name: "A" }],
      localExpert: { restaurants: [{ name: "Hidden Gem Diner" }], activities: [] },
    }), { compress: false });
    const rawWithout = withoutLocal.output();
    const rawWith = withLocal.output();
    assert("no localExpert data -> no 'Locally Sourced' text", !rawWithout.includes("Locally Sourced"));
    assert("localExpert data present -> 'Locally Sourced' section renders", rawWith.includes("Locally Sourced") && rawWith.includes("Hidden Gem Diner"));
  }

  // ---- Guidelines and note render on the header without crashing ----
  {
    const payload = basePayload({
      guidelines: "Dinner spots good for a celebration, walking distance from the plaza.",
      note: "Bolton Landing is a small lakeside village.",
      restaurants: [{ name: "A" }],
    });
    const pdf = await buildFindPdf(payload);
    assert("guidelines + note render without error", pdf.getNumberOfPages() >= 1);
  }

  // ---- Many entries paginate correctly (multi-page) ----
  {
    const restaurants = Array.from({ length: 20 }, (_, i) => ({
      name: `Restaurant ${i}`,
      why: "A solid pick with a long enough description to take up real vertical space on the page so pagination is actually exercised by this test.",
      contact: { phone: `+1 518-555-01${String(i).padStart(2, "0")}`, website: `https://example.com/r${i}`, address: `${i} Main St, Bolton Landing, NY` },
    }));
    const activities = Array.from({ length: 15 }, (_, i) => ({ text: `Activity ${i} — a fun thing to do`, why: "Worth the trip." }));
    const pdf = await buildFindPdf(basePayload({ restaurants, activities }));
    assert("large result set spans multiple pages", pdf.getNumberOfPages() > 1, pdf.getNumberOfPages());
  }

  // ---- Footer includes page numbers and brand on every page ----
  {
    const restaurants = Array.from({ length: 20 }, (_, i) => ({ name: `Restaurant ${i}`, why: "x".repeat(200) }));
    const pdf = await buildFindPdf(basePayload({ restaurants }), { compress: false });
    const raw = pdf.output();
    assert("footer brand text present", raw.includes("www.routesmith.ai"));
    const total = pdf.getNumberOfPages();
    assert("multi-page doc has page-number text", raw.includes(`1 / ${total}`) && total > 1, total);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
