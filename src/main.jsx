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

// TEMPORARY diagnostic overlay — opt-in via ?debugoverflow=1, invisible to
// every normal visitor. Investigating a real, confirmed (swipe-to-reveal)
// horizontal overflow reported on iOS Chrome/Safari (WebKit) that has never
// once reproduced in this repo's Chromium-based testing. Rather than keep
// guessing at CSS from a browser that can't show the bug, this renders the
// actual scrollWidth/clientWidth/visualViewport numbers AND the specific
// offending element straight onto the failing device's screen. Remove once
// the root cause is confirmed and fixed.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debugoverflow') === '1') {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b00020;color:#fff;font:11px/1.4 monospace;padding:8px 10px;max-height:45vh;overflow:auto;white-space:pre-wrap;word-break:break-all;'
  document.body.appendChild(panel)

  function isClippedByAncestor(el, vw) {
    let p = el.parentElement
    let hops = 0
    while (p && hops < 8) {
      const cs = window.getComputedStyle(p)
      const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden' || cs.overflow === 'clip'
      if (clips) {
        const pr = p.getBoundingClientRect()
        if (pr.right <= vw + 1) return true // ancestor itself is on-screen and clips -> el's overflow is invisible
      }
      p = p.parentElement
      hops++
    }
    return false
  }

  function scan() {
    const de = document.documentElement
    const vw = de.clientWidth
    const vv = window.visualViewport
    const offenders = []
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1 && r.width > 0 && !isClippedByAncestor(el, vw)) {
        offenders.push({ el, r })
      }
    })
    offenders.sort((a, b) => b.r.right - a.r.right)
    const lines = []
    lines.push(`UA: ${navigator.userAgent}`)
    lines.push(`innerWidth=${window.innerWidth} outerWidth=${window.outerWidth} dpr=${window.devicePixelRatio}`)
    lines.push(`visualViewport: width=${vv ? vv.width.toFixed(1) : 'n/a'} scale=${vv ? vv.scale.toFixed(3) : 'n/a'} offsetLeft=${vv ? vv.offsetLeft.toFixed(1) : 'n/a'}`)
    lines.push(`document.documentElement: scrollWidth=${de.scrollWidth} clientWidth=${de.clientWidth} OVERFLOW=${de.scrollWidth - de.clientWidth}px`)
    lines.push(`body: scrollWidth=${document.body.scrollWidth} clientWidth=${document.body.clientWidth}`)
    lines.push(`--- ${offenders.length} unclipped overflowing element(s), widest first ---`)
    offenders.slice(0, 5).forEach((o, i) => {
      lines.push(`#${i + 1} right=${Math.round(o.r.right)} width=${Math.round(o.r.width)} tag=${o.el.tagName} class="${(o.el.className + '').slice(0, 40)}"`)
      lines.push(`    ${o.el.outerHTML.slice(0, 220)}`)
    })
    panel.textContent = lines.join('\n')
  }

  scan()
  setInterval(scan, 1000)
  window.addEventListener('resize', scan)
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scan)
}

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
