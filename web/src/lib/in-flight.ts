// How many of the app's own requests are in flight right now, for the settle
// marker (components/SettledMarker.tsx).
//
// The marker counted React Query's work only. The sign-in check (/me) and any
// request made outside a query went unseen, so between two waves of loading
// (signed in, then the workspace, then the page) the app read as settled with
// nothing on the page yet, and a walk judged it there (#4286).
let count = 0;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

export async function counted<T>(work: () => Promise<T>): Promise<T> {
  count++;
  tell();
  try {
    return await work();
  } finally {
    count--;
    tell();
  }
}

export function inFlight(): number {
  return count;
}

export function onInFlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
