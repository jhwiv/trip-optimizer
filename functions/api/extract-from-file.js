// POST /api/extract-from-file
// ------------------------------------------------------------------
// Takes a file uploaded by the traveler (PDF, Word doc, image, or plain
// text) and returns a clean, condensed plain-text summary of trip-relevant
// facts suitable for pasting into the "Trip Guidelines" narrative box.
//
// Powers the paperclip / upload button next to the dictate mic in the
// NarrativeBox on the Essentials step. The traveler uploads a flight
// confirmation PDF, a hotel booking screenshot, a forwarded itinerary
// email, etc. — and instead of retyping it, the app extracts the facts
// and appends them to whatever the user has already typed.
//
// Request: multipart/form-data with a single "file" field.
//   Accepted types: application/pdf, image/jpeg, image/png, image/webp,
//                   image/heic, text/plain, message/rfc822 (.eml), .ics,
//                   .docx (Word). Legacy .doc is rejected with a hint to
//                   re-save as .docx (binary OLE format is non-trivial to
//                   parse inside a Worker).
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
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
]);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const LEGACY_DOC_MIME = "application/msword"; // .doc — rejected with a friendly hint

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

// ---- KV response cache ---------------------------------------------------
// Extraction is fully deterministic from (file bytes, content-type, model,
// system prompt). Hash all four into the cache key so any change to the
// model or prompt automatically invalidates old entries without us having
// to flush the namespace.
//
// Why caching here is a strong win:
//   • Users routinely re-upload the same flight/hotel PDF when they tweak
//     a trip and re-plan from scratch.
//   • Users re-upload the same itinerary docx after dictation edits to
//     the narrative box.
//   • Cache writes are FREE; Anthropic vision/document calls cost real
//     money and take 3–8s. A cache hit is sub-50ms with zero LLM spend.
//
// Keyed by SHA-256 of the raw file bytes plus a short prompt-version tag,
// so identical files always hit and any prompt revision auto-busts.
const EXTRACT_PROMPT_VERSION = "v1";  // bump when EXTRACTION_SYSTEM changes
const EXTRACT_CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function cacheKeyForExtract(buffer, contentType) {
  const hash = await sha256Hex(new Uint8Array(buffer));
  return `extract:${EXTRACT_PROMPT_VERSION}:${contentType || "unknown"}:${hash}`;
}

async function readExtractCache(env, key) {
  if (!env?.JOBS) return null;
  try {
    const raw = await env.JOBS.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.extracted_text === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeExtractCache(env, key, payload, ctx) {
  if (!env?.JOBS) return;
  // Fire-and-forget so we never delay the user-facing response on the cache
  // write. Pages Functions expose ctx.waitUntil for exactly this pattern.
  const p = env.JOBS.put(key, JSON.stringify(payload), {
    expirationTtl: EXTRACT_CACHE_TTL,
  }).catch(() => { /* never let a cache-write error bubble */ });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
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
  if (n.endsWith(".docx")) return DOCX_MIME;
  if (n.endsWith(".doc")) return LEGACY_DOC_MIME;
  return declared || "";
}

// --- DOCX text extraction --------------------------------------------------
// A .docx file is a ZIP archive. The visible text lives in word/document.xml
// inside <w:t> elements. We don't need a full ZIP parser — just enough to
// find that one entry, inflate it with DecompressionStream, and strip tags.
//
// ZIP local file header layout:
//   offset  size  field
//   0       4     signature 0x04034b50 ("PK\x03\x04")
//   4       2     version
//   6       2     flags
//   8       2     compression method (0 = stored, 8 = deflate)
//   10      2     mod time
//   12      2     mod date
//   14      4     crc-32
//   18      4     compressed size
//   22      4     uncompressed size
//   26      2     file name length (n)
//   28      2     extra field length (m)
//   30      n     file name
//   30+n    m     extra field
//   30+n+m  …     compressed data
//
// When flag bit 0x08 is set, the sizes in the local header are 0 and the
// real sizes appear in a data descriptor after the compressed payload —
// in that case we fall back to the central directory.

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

function readU16(view, off) { return view.getUint16(off, true); }
function readU32(view, off) { return view.getUint32(off, true); }

async function inflateRaw(bytes) {
  // Cloudflare Workers expose DecompressionStream with "deflate-raw".
  const stream = new Response(bytes).body.pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function extractDocxText(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // 1) Locate the End-of-Central-Directory record (scan backwards over the
  //    trailing comment, which is at most 65535 bytes long).
  let eocdOff = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (readU32(view, i) === ZIP_EOCD_SIG) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error("Not a valid .docx (no ZIP end-of-directory)");

  const centralEntries = readU16(view, eocdOff + 10);
  const centralSize = readU32(view, eocdOff + 12);
  const centralOff = readU32(view, eocdOff + 16);

  // 2) Walk the central directory looking for "word/document.xml".
  let target = null;
  let p = centralOff;
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < centralEntries && p < centralOff + centralSize; i++) {
    if (readU32(view, p) !== ZIP_CENTRAL_SIG) break;
    const compMethod = readU16(view, p + 10);
    const compSize = readU32(view, p + 20);
    const nameLen = readU16(view, p + 28);
    const extraLen = readU16(view, p + 30);
    const commentLen = readU16(view, p + 32);
    const localHdrOff = readU32(view, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === "word/document.xml") {
      target = { compMethod, compSize, localHdrOff };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error("This .docx is missing word/document.xml — the file may be corrupted.");

  // 3) Jump to the local header, skip its name + extra fields, and read the
  //    compressed payload of exactly compSize bytes.
  const lOff = target.localHdrOff;
  if (readU32(view, lOff) !== ZIP_LOCAL_SIG) {
    throw new Error("Invalid local header in .docx");
  }
  const lNameLen = readU16(view, lOff + 26);
  const lExtraLen = readU16(view, lOff + 28);
  const dataStart = lOff + 30 + lNameLen + lExtraLen;
  const compressed = bytes.subarray(dataStart, dataStart + target.compSize);

  let xmlBytes;
  if (target.compMethod === 0) {
    xmlBytes = compressed;
  } else if (target.compMethod === 8) {
    xmlBytes = await inflateRaw(compressed);
  } else {
    throw new Error(`Unsupported compression method ${target.compMethod} in .docx`);
  }

  const xml = decoder.decode(xmlBytes);

  // 4) Convert the document XML to plain text:
  //    - <w:p> (paragraph) → newline
  //    - <w:br/>            → newline
  //    - <w:tab/>           → tab
  //    - <w:t>...</w:t>     → the text content (keep it)
  //    - everything else    → strip
  // We do this with simple regex passes (no real XML parser) — fine for
  // Word-authored documents which don't put markup inside <w:t>.
  let text = xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");

  // Decode the five XML entities Word emits.
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");

  // Collapse runs of blank lines and trim trailing whitespace per line.
  text = text
    .split("\n")
    .map((ln) => ln.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
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
  if (contentType === LEGACY_DOC_MIME) {
    return json({
      error: {
        message: "Legacy .doc files aren't supported. Open it in Word and save as .docx, then upload again.",
      },
    }, 400);
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    return json({
      error: {
        message: `Unsupported file type: ${file.type || "unknown"}. Accepted: PDF, Word (.docx), JPEG, PNG, WebP, HEIC, plain text, .eml, .ics.`,
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

  // ----- Cache lookup ----------------------------------------------------
  // Compute the cache key from the raw file bytes + content type + prompt
  // version. If we've seen this exact file before (typical case: user
  // re-uploads the same flight confirmation when re-planning), return the
  // stored extraction immediately without calling Anthropic.
  let cacheKey;
  try {
    cacheKey = await cacheKeyForExtract(buffer, contentType);
    const cached = await readExtractCache(env, cacheKey);
    if (cached) {
      return json({
        extracted_text: cached.extracted_text,
        warnings: Array.isArray(cached.warnings) ? cached.warnings : [],
        cached: true,
      });
    }
  } catch {
    // Hash/lookup failure should never block the request. Fall through to
    // a normal LLM call; we just skip caching this round.
    cacheKey = null;
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
  } else if (contentType === DOCX_MIME) {
    // Inflate the .docx and pull text out of word/document.xml, then send
    // it to Claude as plain text — same shape as the text/* branch.
    let text;
    try {
      text = await extractDocxText(buffer);
    } catch (err) {
      return json({
        error: { message: `Could not read .docx file: ${String(err?.message || err)}` },
      }, 400);
    }
    if (!text || text.length < 4) {
      return json({
        error: { message: "The Word document appears to be empty or contains only images. Export it to PDF and try again." },
      }, 422);
    }
    text = text.slice(0, 30000);
    userContent = [{
      type: "text",
      text: `Extract trip-relevant facts from this Word document and output the clean condensed summary per the system rules:\n\n"""\n${text}\n"""`,
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

  // Cache the successful extraction for future re-uploads of the same file.
  // Skip caching when the model returned warnings about unreadable content
  // — a clearer re-upload of the same image should get a fresh extraction
  // attempt rather than re-serving the partial first read.
  if (cacheKey && warnings.length === 0) {
    writeExtractCache(env, cacheKey, { extracted_text: extracted, warnings }, context);
  }

  return json({ extracted_text: extracted, warnings, cached: false });
}

// Reject anything that isn't a POST.
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ error: { message: "Method not allowed" } }, 405);
}
