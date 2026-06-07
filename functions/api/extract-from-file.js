// POST /api/extract-from-file
// ------------------------------------------------------------------
// Takes a file uploaded by the traveler (PDF, image, or plain text) and
// returns a clean, condensed plain-text summary of trip-relevant facts
// suitable for pasting into the "Trip Guidelines" narrative box.
//
// Powers the paperclip / upload button next to the dictate mic in the
// NarrativeBox on the Essentials step. The traveler uploads a flight
// confirmation PDF, a hotel booking screenshot, a forwarded itinerary
// email, etc. — and instead of retyping it, the app extracts the facts
// and appends them to whatever the user has already typed.
//
// Request: multipart/form-data with a single "file" field.
//   Accepted types: application/pdf, image/jpeg, image/png, image/webp,
//                   image/heic, text/plain, message/rfc822 (.eml), .ics
//   Size limit: 20 MB (Cloudflare Pages Function body limit is 100MB
//   but Anthropic caps documents at 32MB; we soft-cap further to keep
//   latency reasonable).
//
// Returns:
//   200 { extracted_text: "...", warnings: [] }
//   400 { error: { message } } — bad request / unsupported type / too big
//   422 { error: { message } } — model returned no useful content
//   500 { error: { message } } — upstream / config failure
//
// Non-streaming, single Anthropic vision/document call. ~3–8s typical.

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
  "message/rfc822",
  "text/calendar",
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Convert an ArrayBuffer to base64. Cloudflare Workers don't have Buffer,
// so we walk the bytes in chunks (avoiding the 64KB call-stack limit on
// btoa(String.fromCharCode(...bytes)) for large PDFs).
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

// Heuristic: many phones report HEIC files with the wrong MIME. Coerce
// some known-good extensions even if the browser sent us octet-stream.
function normalizeContentType(name, declared) {
  const n = String(name || "").toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".heic") || n.endsWith(".heif")) return "image/heic";
  if (n.endsWith(".txt")) return "text/plain";
  if (n.endsWith(".eml")) return "message/rfc822";
  if (n.endsWith(".ics")) return "text/calendar";
  return declared || "";
}

const EXTRACTION_SYSTEM = `You read trip-related documents (flight confirmations, hotel bookings, itinerary emails, calendar invites, screenshots, photos of paper itineraries) and produce a CLEAN, CONDENSED plain-text summary the traveler can paste directly into their trip-planning app.

OUTPUT RULES — STRICT:
• Output PLAIN TEXT only. No markdown headers, no JSON, no preamble, no "Here is the summary:" boilerplate. Just the facts, ready to paste.
• Preserve every factual detail that affects planning: flight numbers, airports, dates, times, confirmation numbers, hotel names + check-in/out dates + room type + confirmation, restaurant reservations with party size + time, car rental details, named guides/drivers, dietary notes, mobility notes, traveler names, kids' ages, anniversary/special-occasion flags.
• Use the EXACT names/numbers from the document. Do not normalize ("United 1040" stays "United 1040", "UA 1040" stays "UA 1040"). Do not invent confirmation numbers.
• Format as natural sentences a human typed, NOT a structured list. Example:
    "United UA 1040 EWR→AUA Sept 12 dep 8:30am arr 12:50pm, return UA 1039 Sept 19 dep 1:45pm. Confirmation ABCD12. Staying at Ritz-Carlton Aruba Sept 12–19, ocean-view suite, conf #RC8881. Dinner Atardi night 1 at 7pm (party of 2). Anniversary on the 14th."
• If the document has multiple legs, hotels, or reservations, list them all but keep flowing prose. Group by what's natural (flights together, then hotel, then dining).
• When ANY field is ambiguous, misspelled, partially cut off, or you can't read it from the image, do NOT guess. Mention it at the end as a separate sentence: "Could not read: [what was unclear]" — so the traveler knows to fill it in.
• If the document is NOT a trip-related document (random photo, unrelated PDF, etc.), output exactly: "This file does not appear to contain trip details."
• Keep the output under 1500 characters when possible. The traveler is going to paste this into a 4000-character box.

DO NOT include the document type ("This is a flight confirmation..."). Just the facts.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { message: "Server missing ANTHROPIC_API_KEY" } }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ error: { message: `Bad multipart body: ${String(err?.message || err)}` } }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: { message: "Missing 'file' field in form data" } }, 400);
  }

  const contentType = normalizeContentType(file.name, file.type);
  if (!ALLOWED_TYPES.has(contentType)) {
    return json({
      error: {
        message: `Unsupported file type: ${file.type || "unknown"}. Accepted: PDF, JPEG, PNG, WebP, HEIC, plain text, .eml, .ics.`,
      },
    }, 400);
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    return json({
      error: {
        message: `File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Max 20 MB. Try compressing or cropping.`,
      },
    }, 400);
  }
  if (buffer.byteLength === 0) {
    return json({ error: { message: "File is empty." } }, 400);
  }

  // Build the user-content block for Anthropic. Three shapes:
  //   - Plain text  → wrapped in a text block
  //   - PDF         → document block with base64 source
  //   - Images      → image block with base64 source (HEIC is upcast to
  //                   image/jpeg by Anthropic's pipeline automatically;
  //                   we leave the declared type as-is and let the API
  //                   convert)
  let userContent;
  if (contentType === "text/plain" || contentType === "message/rfc822" || contentType === "text/calendar") {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    } catch {
      return json({ error: { message: "Could not decode text file (not UTF-8)." } }, 400);
    }
    text = text.slice(0, 30000); // hard cap for plain-text inputs
    userContent = [{
      type: "text",
      text: `Extract trip-relevant facts from this document and output the clean condensed summary per the system rules:\n\n"""\n${text}\n"""`,
    }];
  } else if (contentType === "application/pdf") {
    const b64 = arrayBufferToBase64(buffer);
    userContent = [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: b64 },
      },
      {
        type: "text",
        text: "Extract trip-relevant facts from this document and output the clean condensed summary per the system rules.",
      },
    ];
  } else {
    // image/*
    const b64 = arrayBufferToBase64(buffer);
    // Anthropic accepts jpeg / png / gif / webp. HEIC is not listed; coerce.
    const apiMediaType = (contentType === "image/heic" || contentType === "image/heif")
      ? "image/jpeg" // best-effort — many phones already JFIF-wrap HEIC for sharing
      : contentType;
    userContent = [
      {
        type: "image",
        source: { type: "base64", media_type: apiMediaType, data: b64 },
      },
      {
        type: "text",
        text: "Extract trip-relevant facts from this image and output the clean condensed summary per the system rules.",
      },
    ];
  }

  const upstreamBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: userContent }],
  };

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    return json({ error: { message: `Upstream fetch failed: ${String(err?.message || err)}` } }, 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return json(
      {
        error: {
          message: `Upstream ${upstream.status}`,
          detail: errText.slice(0, 500),
        },
      },
      upstream.status === 413 ? 400 : 502,
    );
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json({ error: { message: "Upstream returned non-JSON" } }, 502);
  }

  // Collect any text blocks from the response.
  const textBlocks = Array.isArray(payload?.content)
    ? payload.content.filter((c) => c?.type === "text").map((c) => String(c?.text || ""))
    : [];
  const extracted = textBlocks.join("\n").trim();

  if (!extracted) {
    return json({
      error: { message: "Model returned no extracted text. Try a clearer image or a different file." },
    }, 422);
  }

  // If the model bailed (file isn't trip-related), surface that as a 422
  // so the client can show a friendly inline message instead of dumping
  // the bail-out sentence into the textarea.
  if (/this file does not appear to contain trip details/i.test(extracted)) {
    return json({
      error: { message: "This file doesn't look like a trip document. Try a flight confirmation, hotel booking, or itinerary screenshot." },
    }, 422);
  }

  // Soft warnings — surface "Could not read:" segments so the client can
  // show them as a yellow hint, but still include them in extracted_text.
  const warnings = [];
  const unreadable = extracted.match(/could not read:\s*[^\n.]+/gi);
  if (unreadable) warnings.push(...unreadable.map((s) => s.trim()));

  return json({ extracted_text: extracted, warnings });
}

// Reject anything that isn't a POST.
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: { message: "Method not allowed" } }, 405);
}
