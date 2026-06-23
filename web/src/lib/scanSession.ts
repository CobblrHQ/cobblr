// Auto-by-time-gap scan SESSION, shared by the hardware-wedge paths
// (GlobalScanWedge + ScanPage's scan-drive) and the camera.
//
// A "session" is a run of scans close in time — a shelf-walk. Scans flow into
// the same scan_batch_id until the scanner goes idle past SESSION_GAP_MS (or the
// calendar day rolls over), after which the next scan mints a fresh batch. This
// is what makes hardware-scanner scans GROUP (previously the wedge sent no
// batch, so every scan was sessionless and nothing could be grouped).
//
// Persisted in localStorage (NOT sessionStorage — phones kill background tabs,
// and resuming the same shelf-walk is the whole point) under the SAME key the
// camera uses, so camera + wedge scans inside the window land in one session.

export interface ScanSession {
  batchId: string | null;
  /** The scan area/location tag carried through the session (optional). */
  areaId: string | null;
  count: number;
  /** Epoch ms of the last scan in this session. */
  at: number;
}

/** New session after this much idle. 30 min = a generous shelf-walk pause. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

const sessionKey = (slug: string) => `cobblr.scan-session.${slug}`;

export function readScanSession(slug: string): ScanSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(slug));
    return raw ? (JSON.parse(raw) as ScanSession) : null;
  } catch {
    return null;
  }
}

export function writeScanSession(slug: string, s: ScanSession): void {
  try {
    localStorage.setItem(sessionKey(slug), JSON.stringify(s));
  } catch {
    // Storage full / private mode — sessions just won't persist.
  }
}

/** End the current session — the next scan mints a fresh batch ("New session"). */
export function clearScanSession(slug: string): void {
  try {
    localStorage.removeItem(sessionKey(slug));
  } catch {
    /* ignore */
  }
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** Is the persisted session still the ACTIVE one (recent + same day)? */
export function isSessionFresh(s: ScanSession | null, now = Date.now()): boolean {
  return !!s?.batchId && now - s.at <= SESSION_GAP_MS && sameDay(s.at, now);
}

/**
 * Resolve the batch this scan belongs to. Reuses the active session's batch when
 * it's still fresh (< SESSION_GAP_MS idle AND same calendar day); otherwise mints
 * a new batch via `mint` and starts a fresh session. Always advances the session
 * timestamp + count. A failed mint returns null (un-batched) and NEVER blocks the
 * scan itself.
 */
export async function resolveSessionBatch(
  slug: string,
  mint: () => Promise<string | null>,
  now = Date.now(),
): Promise<string | null> {
  const s = readScanSession(slug);
  if (isSessionFresh(s, now) && s) {
    writeScanSession(slug, { ...s, count: s.count + 1, at: now });
    return s.batchId;
  }
  const batchId = await mint();
  writeScanSession(slug, { batchId, areaId: s?.areaId ?? null, count: 1, at: now });
  return batchId;
}
