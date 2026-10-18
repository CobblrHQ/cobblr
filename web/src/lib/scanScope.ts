// The scan scope this session is scanning within (#6892,
// scan-serial-number-resolution.md D5): "everything I scan now is a Widget
// X". Held in sessionStorage, per workspace, so it lives as long as the tab
// and never quietly carries into next week's scanning; sent with every
// resolve, where the server decides among the matches it holds. The camera
// and the wedge read it; the chip names it and clears it in one tap.
import { useSyncExternalStore } from "react";

export interface ScanScopeHeld {
  kind?: string | null;
  within?: { kind: string; id: string } | null;
  /** What the chip says: "Widget X", "Bookshelf". */
  label: string;
}

const KEY = (slug: string) => `cobblr.scan-scope.${slug}`;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: ScanScopeHeld | null }>();

function readRaw(slug: string): string | null {
  try {
    return window.sessionStorage.getItem(KEY(slug));
  } catch {
    return null;
  }
}

export function readScanScope(slug: string | null | undefined): ScanScopeHeld | null {
  if (!slug) return null;
  const raw = readRaw(slug);
  const hit = cache.get(slug);
  if (hit && hit.raw === raw) return hit.value;
  let value: ScanScopeHeld | null = null;
  try {
    const v = raw ? (JSON.parse(raw) as ScanScopeHeld) : null;
    value = v && typeof v.label === "string" && (v.kind || v.within) ? v : null;
  } catch {
    value = null;
  }
  cache.set(slug, { raw, value });
  return value;
}

export function setScanScope(slug: string, scope: ScanScopeHeld | null): void {
  try {
    if (scope) window.sessionStorage.setItem(KEY(slug), JSON.stringify(scope));
    else window.sessionStorage.removeItem(KEY(slug));
  } catch {
    // A private window without storage: the scope simply does not hold.
  }
  for (const l of listeners) l();
}

/** What a resolve sends: the scope without its label. */
export function scopeForResolve(slug: string | null | undefined): { kind?: string | null; within?: { kind: string; id: string } | null } | undefined {
  const s = readScanScope(slug);
  return s ? { ...(s.kind ? { kind: s.kind } : {}), ...(s.within ? { within: s.within } : {}) } : undefined;
}

export function useScanScope(slug: string | null | undefined): ScanScopeHeld | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => readScanScope(slug),
    () => null,
  );
}
