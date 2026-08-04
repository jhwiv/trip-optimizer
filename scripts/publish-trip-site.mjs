// Turns a RouteSmith itinerary into a ready-to-deploy static site folder —
// the local half of "itinerary build -> standalone web app on its own domain."
//
// Input can be EITHER:
//   - a raw plan JSON file (the same shape src/App.jsx's `result` state holds), or
//   - an HTML file already produced by "Export as web app" / /api/share — this
//     script extracts the embedded <script id="trip-data"> JSON and rebuilds
//     from that, so a file the user already has works directly.
//
// Output, written to --out (default dist-sites/<slug>/), mirrors the actual
// deploy conventions already used by this account's existing trip sites
// (jhwiv/zurich-weekend, jhwiv/santafe-itinerary, jhwiv/barrier-island-digital):
//   - index.html       — from buildWebApp(), the same function that drives
//                         the app's own "Export as web app" / "Get shareable
//                         link" buttons, so there is exactly one source of
//                         truth for what an exported page looks like.
//   - _headers         — Cloudflare cache rules. buildWebApp's output is a
//                         single self-contained file (inline <style>/<script>,
//                         no separate CSS/JS), so unlike barrier-island-digital's
//                         content-hashed-asset setup, the only rule needed is
//                         "never cache the HTML" — every deploy goes live
//                         immediately with no stale-edge-cache surprise.
//   - wrangler.toml    — Workers-with-static-assets config, matching the
//                         pattern barrier-island-digital (the most recently
//                         deployed of the three reference sites) already
//                         uses, over the older classic-Pages dashboard flow.
//   - README.md        — local preview + deploy instructions.
//
// This script does NOT create a GitHub repo, push, or touch Cloudflare — it
// has no credentials for either and shouldn't be handed any. Publishing a
// new site is still a deliberate, per-trip action: create the repo, push
// these files, then either connect it in the Cloudflare dashboard (Workers &
// Pages -> Create -> Import a repository) or run `npx wrangler deploy`
// locally with your own `wrangler login`.
//
// Usage:
//   node scripts/publish-trip-site.mjs <plan.json|export.html> --name <repo-slug> [--out <dir>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebApp } from "../src/webExport.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

function slugify(s) {
  return (s || "trip").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") args.name = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--inputs") args.inputs = argv[++i];
    else args._.push(a);
  }
  return args;
}

function loadPlan(inputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");
  if (inputPath.endsWith(".html")) {
    const m = raw.match(/<script id="trip-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) {
      throw new Error(`No <script id="trip-data"> block found in ${inputPath} — is this a RouteSmith export?`);
    }
    return JSON.parse(m[1]);
  }
  return JSON.parse(raw);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args._[0];
  if (!inputPath) {
    console.error("Usage: node scripts/publish-trip-site.mjs <plan.json|export.html> --name <repo-slug> [--out <dir>] [--inputs <inputs.json>]");
    process.exit(1);
  }

  const plan = loadPlan(inputPath);
  const inputs = args.inputs ? JSON.parse(fs.readFileSync(args.inputs, "utf8")) : {};

  const slug = slugify(args.name || plan.destination);
  const outDir = args.out ? path.resolve(args.out) : path.join(REPO_ROOT, "dist-sites", slug);
  fs.mkdirSync(outDir, { recursive: true });

  const html = buildWebApp(plan, inputs);
  fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");

  const headers = [
    "# Cloudflare Pages / Workers reads this file to set HTTP headers on responses.",
    "# https://developers.cloudflare.com/pages/configuration/headers/",
    "#",
    "# buildWebApp() output is a single self-contained file (inline CSS/JS,",
    "# no separate assets to content-hash) — so the only rule that matters is",
    "# never caching the HTML, so every deploy goes live immediately.",
    "/",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "/index.html",
    "  Cache-Control: no-cache, no-store, must-revalidate",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "_headers"), headers, "utf8");

  const wranglerToml = [
    `name = "${slug}"`,
    `compatibility_date = "${new Date().toISOString().slice(0, 10)}"`,
    "",
    "[assets]",
    'directory = "./"',
    'not_found_handling = "404-page"',
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "wrangler.toml"), wranglerToml, "utf8");

  const readme = [
    `# ${plan.destination || slug}`,
    "",
    "Generated by RouteSmith's `scripts/publish-trip-site.mjs` from an itinerary export.",
    "Static site (single self-contained HTML file). No build step.",
    "",
    "## Local preview",
    "```bash",
    "npx serve .",
    "```",
    "",
    "## Deploy — Cloudflare Workers (static assets)",
    "```bash",
    `npx wrangler deploy`,
    "```",
    "First run will prompt `wrangler login`. Subsequent deploys from this",
    "directory reuse the same project (`name` in wrangler.toml).",
    "",
    "## Deploy — Cloudflare Pages (git-connected, alternative)",
    "In the Cloudflare dashboard: Workers & Pages -> Create -> Pages -> Connect",
    "to Git -> select this repo. Build command: none. Build output directory: `/`.",
    "",
    "## Custom domain",
    "Once deployed, attach a domain under Workers & Pages -> (this project) ->",
    "Custom domains, then point its DNS at Cloudflare (or transfer the zone).",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "README.md"), readme, "utf8");

  console.log(`Wrote site to ${outDir}`);
  console.log(`  index.html   ${(html.length / 1024).toFixed(1)} KB`);
  console.log(`  _headers, wrangler.toml, README.md`);
  console.log("");
  console.log("Next steps (not run by this script):");
  console.log(`  1. Create a GitHub repo (e.g. jhwiv/${slug}) and push this directory's contents.`);
  console.log(`  2. cd into it and run \`npx wrangler deploy\` (or connect it in the Cloudflare`);
  console.log(`     dashboard under Workers & Pages -> Create -> Import a repository).`);
  console.log(`  3. Attach a custom domain from the project's Custom domains tab, if wanted.`);
}

main();
