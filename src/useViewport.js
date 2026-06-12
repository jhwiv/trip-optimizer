// useViewport — single source of truth for responsive decisions across the
// app. Returns the current viewport width plus a named breakpoint so
// components can branch on something readable like `bp === 'mobile'`
// instead of recalculating `width < 480` everywhere.
//
// Breakpoints:
//   mobile   <  640   phones, narrow tablets in portrait
//   tablet   <  960   iPad portrait, small laptops
//   desktop  < 1280   standard laptops
//   wide     >= 1280  external monitors, full-screen on 14"+ laptops
//
// Why these numbers:
//   - 640 is the existing wizard container max-width; below it, single-column
//     layouts are the right call (forms stack, no side-by-side fields).
//   - 960 is the threshold where wide-form 2-column layouts and side panels
//     become useful without overrunning content width.
//   - 1280 is where we can afford a 3-column itinerary card grid and full
//     hero-width breathing room without the page feeling sparse.
//
// Listening:
//   - Subscribes to window resize via matchMedia(MediaQueryList) which is
//     cheaper than a raw 'resize' listener (fires only when crossing a
//     breakpoint, not on every pixel).
//   - SSR-safe: returns 'desktop' when window is undefined so the first
//     render on hydration doesn't flash a mobile layout.

import { useState, useEffect, useSyncExternalStore } from "react";

export const BP = {
  MOBILE_MAX: 639,
  TABLET_MAX: 959,
  DESKTOP_MAX: 1279,
};

export function bpName(width) {
  if (width <= BP.MOBILE_MAX) return "mobile";
  if (width <= BP.TABLET_MAX) return "tablet";
  if (width <= BP.DESKTOP_MAX) return "desktop";
  return "wide";
}

// Subscribe model for useSyncExternalStore. One shared subscription per
// breakpoint boundary so multiple components calling the hook don't each
// register their own resize listener.
function subscribe(callback) {
  if (typeof window === "undefined") return () => {};
  const mqs = [
    window.matchMedia(`(max-width: ${BP.MOBILE_MAX}px)`),
    window.matchMedia(`(max-width: ${BP.TABLET_MAX}px)`),
    window.matchMedia(`(max-width: ${BP.DESKTOP_MAX}px)`),
  ];
  for (const mq of mqs) {
    if (mq.addEventListener) mq.addEventListener("change", callback);
    else if (mq.addListener) mq.addListener(callback); // Safari < 14
  }
  return () => {
    for (const mq of mqs) {
      if (mq.removeEventListener) mq.removeEventListener("change", callback);
      else if (mq.removeListener) mq.removeListener(callback);
    }
  };
}

function getSnapshot() {
  if (typeof window === "undefined") return BP.DESKTOP_MAX; // SSR fallback
  return window.innerWidth;
}

function getServerSnapshot() {
  return BP.DESKTOP_MAX; // SSR: assume desktop so hydration isn't mobile-first
}

/**
 * useViewport — returns { width, bp, isMobile, isTablet, isDesktop, isWide }.
 *
 * Re-renders only when crossing one of the named breakpoints (not on every
 * pixel of resize). Safe to call from any component.
 */
export function useViewport() {
  const width = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const bp = bpName(width);
  return {
    width,
    bp,
    isMobile: bp === "mobile",
    isTablet: bp === "tablet",
    isDesktop: bp === "desktop",
    isWide: bp === "wide",
    // Convenience: "at-least" checks for progressive enhancement.
    isAtLeastTablet: bp !== "mobile",
    isAtLeastDesktop: bp === "desktop" || bp === "wide",
  };
}

// Suppress the "useState imported but not used" warning if some bundlers
// don't dead-code-eliminate the legacy export below. useSyncExternalStore
// is the canonical implementation; keep useState/useEffect available for
// a fallback hook in test environments that don't have useSyncExternalStore.
export function useViewportLegacy() {
  const [width, setWidth] = useState(typeof window !== "undefined" ? window.innerWidth : BP.DESKTOP_MAX);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { width, bp: bpName(width) };
}
