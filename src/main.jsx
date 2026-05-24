import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Register the service worker so the app is installable to the home screen and
// usable offline. Only in production builds (dev uses Vite HMR and a SW would
// fight it). Auto-applies updates: when a new SW takes control, reload once so
// the user gets the new bundle without manual cache-clearing.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Non-fatal: app still works without the SW
      console.warn('SW registration failed', err)
    })
  })
}
