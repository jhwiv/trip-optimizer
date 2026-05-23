import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

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

export default defineConfig({
  plugins: [react()],
  define: {
    __API_BASE__: JSON.stringify(apiBase),
    __BUILD_ID__: JSON.stringify(buildId),
  },
})
