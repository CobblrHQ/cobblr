// A workspace whose database was never made (#5146). Any request to it answers
// 503 tenant_unprovisioned; the first one that does marks it here, and the
// workspace shell shows "not set up yet" with a button to finish it, rather
// than a dashboard with nothing in it and no word why.
import { useSyncExternalStore } from "react";

const unfinished = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** api.ts: a request to `slug` answered tenant_unprovisioned. */
export function markWorkspaceUnfinished(slug: string): void {
  if (unfinished.has(slug)) return;
  unfinished.add(slug);
  notify();
}

/** The workspace was finished: show it again. */
export function clearWorkspaceUnfinished(slug: string): void {
  if (unfinished.delete(slug)) notify();
}

/** The workspace slug a request path names, if it is a workspace request. */
export function slugOfRequest(path: string): string | null {
  return /^\/?(?:api\/v1\/)?orgs\/([^/?#]+)/.exec(path)?.[1] ?? null;
}

export function useWorkspaceUnfinished(slug: string | null | undefined): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => !!slug && unfinished.has(slug),
    () => false,
  );
}
