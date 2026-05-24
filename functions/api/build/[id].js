// GET /api/build/<id>?cursor=N
// Returns the job's current text from byte offset N onward, plus status.
// Used by the client to poll for new tokens. Client advances cursor by the
// returned delta length, so subsequent polls only fetch new bytes.
//
// Response: { status, error?, len, model, startedAt, updatedAt, completedAt?, cursor, delta }

export async function onRequestGet(context) {
  const { params, env, request } = context;

  if (!env.JOBS) {
    return json({ error: { message: "Server missing JOBS KV binding." } }, 500);
  }

  const id = String(params.id || "").replace(/[^a-f0-9]/gi, "");
  if (!id) return json({ error: { message: "Bad job id" } }, 400);

  const url = new URL(request.url);
  const cursor = Math.max(0, parseInt(url.searchParams.get("cursor") || "0", 10) || 0);

  const [statusRaw, text] = await Promise.all([
    env.JOBS.get(`job:${id}:status`),
    env.JOBS.get(`job:${id}:text`),
  ]);

  if (statusRaw == null) {
    return json({ error: { message: "Job not found or expired" }, notFound: true }, 404);
  }

  let status;
  try { status = JSON.parse(statusRaw); } catch { status = { status: "error", error: "Status corrupted" }; }

  const full = text || "";
  const delta = cursor >= full.length ? "" : full.slice(cursor);

  return json({
    ...status,
    cursor: full.length,
    delta,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
