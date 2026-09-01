// Web-side managed-app registry — the consumer-facing copy of the server's
// MANAGED_APPS (api/src/platform/managed-apps.ts). Drives the /start/:app
// streamlined signup page: which flagship bundle to provision + the landing
// copy. The server is the source of truth for home_path/label on the flag;
// this adds the marketing headline/blurb for the signup screen.

import type { AppTheme } from "./api";

export interface ManagedAppMeta {
  id: string;
  /** The flagship bundle to install (matched against the catalog by id). */
  bundleId: string;
  label: string;
  /** Signup-screen copy. */
  headline: string;
  blurb: string;
  /** The header reads "[cobblr mark] cobblr <navSuffix>" — the wordmark IS the
   *  "Cobblr", so the app appends a short suffix ("for Yarn") instead of a
   *  separate "Cobblr for Yarn" label that repeats the word. */
  navSuffix: string;
  /** An on-brand palette the LOCKED app wears (the whole shell recolours to it
   *  via the same `--c-*` token override the admin-shell `admin_theme` uses).
   *  Author-defined here; the consumer can't reach platform theming. */
  theme?: AppTheme;
}

export const MANAGED_APPS: Record<string, ManagedAppMeta> = {
  yarn: {
    id: "yarn",
    bundleId: "cobblr.flagship.yarn",
    label: "Cobblr for Yarn",
    navSuffix: "for Yarn",
    headline: "Your yarn stash, sorted.",
    blurb: "Scan a ball-band, never double-buy. Track every skein (colorway, fiber, weight class, dye lot) in one place.",
    // A warm wool/craft palette — parchment page, espresso text, a dusty-rose
    // accent — so Cobblr for Yarn reads as a yarn app, not blueprint Cobblr.
    theme: {
      bg: "#F3ECDF",          // warm parchment
      surface: "#FFFCF7",     // soft warm white (cards)
      text: "#3B2F27",        // espresso
      muted: "#8C7B6C",       // taupe
      border: "#E6DACA",      // soft warm tan
      accent: "#A84C6B",      // dusty raspberry
      accent_text: "#FFFFFF",
      radius: 14,
    },
  },
};

export function getManagedAppMeta(id: string | undefined): ManagedAppMeta | null {
  return id ? MANAGED_APPS[id] ?? null : null;
}

/** The routes a LOCKED managed-app workspace may visit. A whitelist, so a new
 *  platform page is blocked by default. Shared by the layout guard (which
 *  bounces anything else to the app home) and by the navs (which must not offer
 *  a destination that would bounce). Those used to be two separate lists, which
 *  is how the phone menu came to show Dashboard, Calendar and Configuration to
 *  a knitter and bounce each tap back to the yarn table. */
export const MANAGED_APP_SURFACE = ["/instances", "/scan", "/me"] as const;

export function inManagedAppSurface(pathname: string): boolean {
  return MANAGED_APP_SURFACE.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
