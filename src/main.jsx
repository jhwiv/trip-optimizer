import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { FindView } from './App.jsx'

// Path-aware mount: /find renders the standalone restaurant + activity
// search view as a SIBLING of the wizard — not inside it — so the
// wizard's hooks never execute on /find pages. This is the right place
// to do the branch because main.jsx has no hooks of its own; doing it
// inside TripOptimizer would violate the React rules-of-hooks (early
// return before useState/useEffect calls).
// Match /find, /find/, /find?... — but NOT /findxyz. Anchored exact-segment match.
const FIND_ROUTE_RX = /^\/find(\/|\?|$)/
const isFindRoute = typeof window !== 'undefined'
  && typeof window.location?.pathname === 'string'
  && FIND_ROUTE_RX.test(window.location.pathname + window.location.search)

const Root = isFindRoute ? FindView : App

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)

// Register the service worker so the app is installable to the home screen and
// usable offline. Only in production builds (dev uses Vite HMR and a SW would
// fight it).
//
// Update strategy — the app should feel like an app, not a webpage:
//   1. Register on load.
//   2. POLL for updates every 60s and also whenever the tab regains focus or
//      the network comes back online. Browsers DO NOT re-check sw.js on their
//      own while a tab stays open — the user would otherwise sit on an old
//      version indefinitely.
//   3. When a new SW is found, it enters the 'installing' state and then
//      'waiting'. As soon as it's 'waiting' we postMessage SKIP_WAITING so it
//      activates immediately.
//   4. Once it activates, the 'controllerchange' event fires and we reload
//      the page exactly once — the user lands on the new bundle without
//      ever touching the browser.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })

  // Ask a waiting SW to take over immediately. Wired to both the 'waiting'
  // event on the current registration and any registration we find later.
  const activateWaiting = (reg) => {
    if (reg && reg.waiting) {
      try { reg.waiting.postMessage('SKIP_WAITING') } catch {}
    }
  }

  // Hook into a registration so we react the moment a new SW shows up.
  const wireRegistration = (reg) => {
    if (!reg) return
    activateWaiting(reg)
    // Fires when registration.update() finds a new SW and it starts installing.
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          // New version is installed and an old SW is in control — swap now.
          activateWaiting(reg)
        }
      })
    })
  }

  window.addEventListener('load', () => {
    // updateViaCache: 'none' tells the browser to bypass HTTP caches when
    // fetching the SW script itself. Without this Cloudflare's edge cache
    // can hand us a stale sw.js for up to 24h, defeating the whole update
    // path. (Default is 'imports' — the SW script can be cached.)
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
      wireRegistration(reg)

      // Poll for updates while the tab is open. 60s is frequent enough that a
      // user who left the app open during a deploy picks up the new build in
      // about a minute — but rare enough that we're not hammering Cloudflare.
      const pollMs = 60 * 1000
      setInterval(() => { reg.update().catch(() => {}) }, pollMs)

      // Also check on focus/online — covers the common pattern of switching
      // back to the tab after a few hours.
      window.addEventListener('focus', () => { reg.update().catch(() => {}) })
      window.addEventListener('online', () => { reg.update().catch(() => {}) })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {})
      })
    }).catch((err) => {
      // Non-fatal: app still works without the SW
      console.warn('SW registration failed', err)
    })
  })
}
