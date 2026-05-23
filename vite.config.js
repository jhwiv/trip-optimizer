import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Optional: point /api/chat at a different origin (e.g. the live Cloudflare Pages
// deployment) when building a preview hosted elsewhere. Leave PREVIEW_API_BASE
// unset for the normal production build so the relative /api/chat is used.
const apiBase = process.env.PREVIEW_API_BASE || ''

export default defineConfig({
  plugins: [react()],
  define: {
    __API_BASE__: JSON.stringify(apiBase),
  },
})
