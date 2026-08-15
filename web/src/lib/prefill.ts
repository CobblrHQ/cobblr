// Tier-1.5 escort prefill — the page half of the contract.
//
// When the assistant walks the user to a screen it cannot operate (members,
// tokens, backup — the tier-1 surfaces in docs/design-decisions/
// platform-actions.md), it may carry form values as `prefill.<key>` query
// params. This module is the ONLY reader of those params.
//
// The security property the whole tier rests on: prefill is INERT. Nothing
// here submits, and no page may auto-submit on the strength of a prefill —
// the page's own button, under the page's own role checks, is the consent.
//
// WHY THE VALUES ARE CAPTURED, NOT RE-READ (found on staging, 2026-08-15):
// the params are stripped from the URL the moment they're read, so a copied
// link never carries someone's email. But the consumer is often a component
// that mounts TWICE — the members form renders once, then again when its
// members/invites queries land — and the second mount is the one the user
// sees. Reading straight from the URL meant mount #1 consumed the values and
// mount #2 found a URL that had already been cleaned, so the form the user
// looked at was empty and the escort silently did nothing.
//
// So: read once per page load into a module-level capture, keyed by the path
// it arrived on. Later mounts of the same screen get the same values; a
// navigation elsewhere gets none (a stale prefill must not follow the user
// around the app).

import { useState } from "react";

interface Capture {
  path: string;
  values: Record<string, string>;
}

let capture: Capture | null = null;
let captured = false;

/** Take EVERY `prefill.*` param out of the URL, once, and remember them
 *  against the path they arrived on. Capturing all keys (not just the ones the
 *  first consumer asks for) means a second component on the same screen with
 *  different keys still gets what it was sent. */
function captureOnce(): Capture | null {
  if (captured) return capture;
  captured = true;
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const values: Record<string, string> = {};
  const drop: string[] = [];
  url.searchParams.forEach((value, key) => {
    if (!key.startsWith("prefill.")) return;
    drop.push(key);
    const bare = key.slice("prefill.".length);
    if (bare && value.trim()) values[bare] = value.trim();
  });
  if (drop.length === 0) return null;
  for (const key of drop) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url.toString());
  capture = { path: url.pathname, values };
  return capture;
}

/** The whole rule, as a pure function — capture-once, path-scoped, repeatable.
 *  Exported so it can be tested without a renderer: the remount behaviour IS
 *  the contract, and a hook that can only be exercised through React is a
 *  contract nobody checks. */
export function readPrefill(keys: string[]): Record<string, string> {
  const c = captureOnce();
  if (!c) return {};
  // The capture is for the screen it arrived on. A prefill meant for Members
  // must not resurface on Backup because the user wandered there later.
  if (typeof window !== "undefined" && window.location.pathname !== c.path) return {};
  const out: Record<string, string> = {};
  for (const key of keys) if (c.values[key]) out[key] = c.values[key]!;
  return out;
}

/** Read the escort prefill this page was sent. Keys are the bare names
 *  ("email"), matched to `prefill.email`. Returns {} when the page was reached
 *  normally — or when the capture belongs to a different screen. */
export function usePrefill(keys: string[]): Record<string, string> {
  const [values] = useState<Record<string, string>>(() => readPrefill(keys));
  return values;
}

/** Test seam: forget the capture so a suite can exercise a fresh page load. */
export function __resetPrefillForTests(): void {
  capture = null;
  captured = false;
}
