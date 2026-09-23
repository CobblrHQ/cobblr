// A trial waiting to be brought in, held across the sign-up it arrives at.
//
// The carry door on the demo box sends the person to this deployment's /carry
// page with the grant in the address. They are rarely signed in here yet, and
// signing up (or a round trip through the account service) leaves that page,
// so the grant is kept in the browser until they are back and it is used or
// turned down. Best-effort like every per-browser convenience: storage that
// throws simply means the address itself has to carry it.
const KEY = "cobblr.carry.pending";
/** The grant itself lives 48 hours on the demo box; nothing to hold past it. */
const MAX_AGE_MS = 48 * 3_600_000;

export interface PendingCarry {
  token: string;
  from: string;
}

export function holdCarry(c: PendingCarry): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...c, at: Date.now() }));
  } catch {
    /* private window: the address still carries it */
  }
}

export function pendingCarry(): PendingCarry | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { token?: unknown; from?: unknown; at?: unknown };
    if (typeof v.token !== "string" || typeof v.from !== "string" || typeof v.at !== "number") return null;
    if (Date.now() - v.at > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return { token: v.token, from: v.from };
  } catch {
    return null;
  }
}

export function dropCarry(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing held */
  }
}

/** The grant from this page's address, if it came with one. */
export function carryFromAddress(search: string): PendingCarry | null {
  const q = new URLSearchParams(search);
  const token = q.get("token");
  const from = q.get("from");
  return token && from ? { token, from } : null;
}

/** The grant this page arrived with, held for the sign-up in between; or the
 *  one already held from before it. */
export function takeCarryGrant(search: string): PendingCarry | null {
  const fromAddress = carryFromAddress(search);
  if (fromAddress) holdCarry(fromAddress);
  return fromAddress ?? pendingCarry();
}
