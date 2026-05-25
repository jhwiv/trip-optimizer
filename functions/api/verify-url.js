// POST /api/verify-url
//
// Body: { urls: string[] }
// Returns: { results: [{ url, ok: boolean, status?: number, reason?: string }] }
//
// Why this exists:
//   Model-generated itineraries often include vendor websites/booking pages that
//   are stale, hallucinated, or have moved. Verifying URLs from the browser is
//   blocked by CORS. This endpoint runs server-side, HEAD-probes each URL with
//   a short timeout, and returns a verdict the client can act on:
//     ok → render the link
//     dead → swap to a Google "official site" search fallback
//
// Notes:
//   - HEAD is tried first; many sites return 405 or refuse HEAD, so on 405/501
//     or network error we retry with GET (range-limited).
//   - 2xx and 3xx ⇒ ok. 4xx/5xx ⇒ dead. Network/timeout ⇒ dead.
//   - We cap parallelism + total URLs to keep latency bounded.

const TIMEOUT_MS = 5000;
const MAX_URLS = 60;
const MAX_PARALLEL = 8;
const UA =
  "Mozilla/5.0 (compatible; TripOptimizerVerify/1.0; +https://trip-optimizer-6og.pages.dev)";

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const urls = Array.isArray(body?.urls) ? body.urls : [];
  // Sanitize: keep only http(s), dedupe, cap.
  const cleaned = [];
  const seen = new Set();
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    const u = raw.trim();
    if (!/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    cleaned.push(u);
    if (cleaned.length >= MAX_URLS) break;
  }

  const results = await mapParallel(cleaned, MAX_PARALLEL, verifyOne);
  return json({ results });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function verifyOne(url) {
  // First try HEAD.
  try {
    const head = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" });
    if (head.status === 405 || head.status === 501 || head.status === 0) {
      // Server doesn't allow HEAD — fall through to GET.
    } else if (head.ok || (head.status >= 200 && head.status < 400)) {
      return { url, ok: true, status: head.status };
    } else if (head.status >= 400) {
      // Some sites return 403 to HEAD but render fine on GET; retry once.
      // Otherwise mark dead.
      if (head.status === 403 || head.status === 429) {
        // fall through to GET retry
      } else {
        return { url, ok: false, status: head.status, reason: "http-error" };
      }
    }
  } catch (_err) {
    // HEAD blew up — try GET below.
  }

  try {
    const get = await fetchWithTimeout(url, {
      method: "GET",
      redirect: "follow",
      // Range header keeps it cheap if the origin honors it.
      headers: { Range: "bytes=0-1023" },
    });
    if (get.ok || (get.status >= 200 && get.status < 400)) {
      return { url, ok: true, status: get.status };
    }
    return { url, ok: false, status: get.status, reason: "http-error" };
  } catch (err) {
    return { url, ok: false, reason: errReason(err) };
  }
}

function errReason(err) {
  const msg = String(err?.message || err);
  if (/abort|timeout/i.test(msg)) return "timeout";
  if (/dns|enotfound|getaddrinfo/i.test(msg)) return "dns";
  return "network";
}

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
      cf: { cacheTtl: 300, cacheEverything: false },
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function mapParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        results[idx] = { url: items[idx], ok: false, reason: errReason(err) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
