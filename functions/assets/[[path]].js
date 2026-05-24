// Guard rail: Cloudflare Pages default SPA fallback returns index.html
// (200, text/html) for any unmatched route — including /assets/<old-hash>.js
// when a user's stale tab references a chunk from a previous deploy. That
// HTML response then poisons dynamic imports with
//   "Failed to fetch dynamically imported module"
// and gets cached forever by our service worker.
//
// This catch-all Function runs for every /assets/* request. It asks the
// static-asset binding to serve the file. If the binding returns the
// SPA shell (text/html) for what should be a hashed JS/CSS/etc. asset,
// we convert it into a real 404 so the SW and client can detect the
// stale-shell condition and self-heal.
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Ask Pages' static-asset serving for the file.
  let resp;
  try {
    resp = await env.ASSETS.fetch(request);
  } catch (_) {
    return new Response('', { status: 404 });
  }

  // Determine what content-type SHOULD come back for this path.
  const expected =
    /\.(?:js|mjs)$/.test(path) ? 'javascript' :
    /\.css$/.test(path) ? 'css' :
    /\.json$/.test(path) ? 'json' :
    /\.svg$/.test(path) ? 'svg' :
    null;

  if (!expected) return resp; // images / fonts / unknown — pass through

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  const ok =
    (expected === 'javascript' && (ct.includes('javascript') || ct.includes('ecmascript'))) ||
    (expected === 'css' && ct.includes('css')) ||
    (expected === 'json' && ct.includes('json')) ||
    (expected === 'svg' && ct.includes('svg'));

  if (ok) return resp;

  // Wrong content-type (almost always: HTML SPA-shell for a missing chunk).
  // Return a real 404 so the browser surfaces a network error to the
  // dynamic-import caller, which we catch and self-heal in App.jsx.
  return new Response(
    JSON.stringify({ error: 'asset-not-in-deploy', path }),
    { status: 404, headers: { 'content-type': 'application/json' } }
  );
}
