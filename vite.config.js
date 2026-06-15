import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Optional: point /api/chat at a different origin (e.g. the live Cloudflare Pages
// deployment) when building a preview hosted elsewhere. Leave PREVIEW_API_BASE
// unset for the normal production build so the relative /api/chat is used.
const apiBase = process.env.PREVIEW_API_BASE || ''

// Short build id surfaced in the UI footer + in error messages so we can
// verify from a screenshot which exact bundle the user is running.
const buildId = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch { return new Date().toISOString().slice(0,16).replace(/[-T:]/g,'') }
})()

// Substitute __BUILD_ID__ inside public/sw.js after Vite copies it to dist/.
// Public files are not processed by Vite's `define` transform, so we patch the
// output file in closeBundle. Keeps each deploy's SW cache name unique so old
// shells get evicted.
function swBuildIdPlugin() {
  return {
    name: 'sw-build-id',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(__dirname, 'dist', 'sw.js')
      if (!existsSync(swPath)) return
      const src = readFileSync(swPath, 'utf8')
      writeFileSync(swPath, src.replace(/__BUILD_ID__/g, buildId))
    },
  }
}

export default defineConfig({
  // Use relative asset URLs so the build works behind any deep proxy path
  // (e.g. sites.pplx.app/sites/proxy/<token>/...) in addition to the root.
  base: './',
  plugins: [react(), swBuildIdPlugin()],
  define: {
    __API_BASE__: JSON.stringify(apiBase),
    __BUILD_ID__: JSON.stringify(buildId),
  },
})
