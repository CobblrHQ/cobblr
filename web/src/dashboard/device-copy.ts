// The dashboard as it last stood, kept on this device per person and
// workspace (#6563, snapshot.tsx draws from it). Its own module so signing
// out (lib/api.ts setToken) can forget it without importing the page.
import type { DehydratedState } from "@tanstack/react-query";

export const COPY_PREFIX = "cobblr.dash.v1:";
/** Past this, a copy is not kept: a device's storage is small and shared. */
export const MAX_COPY_CHARS = 1_500_000;

export interface DeviceCopy {
  v: 1;
  at: number;
  state: DehydratedState;
}

/** Only data that comes back from JSON as it went in is kept: a Map or a
 *  Date would come back as something else and break the section it feeds. */
export function isPlainJson(v: unknown, seen = { n: 0 }): boolean {
  if (++seen.n > 200_000) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (v === undefined) return true;
  if (Array.isArray(v)) return v.every((x) => x !== undefined && isPlainJson(x, seen));
  if (typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v as Record<string, unknown>).every((x) => isPlainJson(x, seen));
}

export function readCopy(key: string): DeviceCopy | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const c = JSON.parse(raw) as DeviceCopy;
    return c?.v === 1 && c.state ? c : null;
  } catch {
    return null;
  }
}

export function writeCopy(key: string, copy: DeviceCopy): void {
  try {
    const raw = JSON.stringify(copy);
    if (raw.length > MAX_COPY_CHARS) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  } catch {
    // Storage full or refused: the next visit asks, as a first one does.
  }
}

/** Forget every dashboard copy on this device (signing out). */
export function forgetDashboardCopies(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(COPY_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // Nothing kept, or nothing reachable: nothing to forget.
  }
}
