// The shell's lists before drag-to-reorder has loaded: the same rows, in the
// same order, with nothing to drag. No dnd-kit import, so the first page load
// does not carry it (sort-kit.tsx, loaded after the first paint, does).
import { useEffect, useState, type ReactNode } from "react";

export interface SortKit {
  /** False until the drag code has loaded; a grip handle hides until then. */
  draggable: boolean;
  Root: (p: { grip: "hold" | "pointer"; onDrop: (activeId: string, overId: string) => void; children: ReactNode }) => ReactNode;
  Group: (p: { ids: string[]; children: ReactNode }) => ReactNode;
  Row: (p: { id: string; children: (handle: Record<string, unknown>) => ReactNode }) => ReactNode;
  Child: (p: { id: string; children: ReactNode }) => ReactNode;
  Handled: (p: { id: string; children: (grip: Record<string, unknown> | null) => ReactNode }) => ReactNode;
}

const NO_HANDLE: Record<string, unknown> = {};

export const staticSortKit: SortKit = {
  draggable: false,
  Root: ({ children }) => <>{children}</>,
  Group: ({ children }) => <>{children}</>,
  Row: ({ children }) => <div>{children(NO_HANDLE)}</div>,
  Child: ({ children }) => <div>{children}</div>,
  Handled: ({ children }) => <div>{children(null)}</div>,
};

let loaded: SortKit | null = null;
let loading: Promise<SortKit> | null = null;
/** Fetch the drag code once; every list after the first starts draggable. */
export function loadSortKit(): Promise<SortKit> {
  loading ??= import("./sort-kit").then(
    (m) => (loaded = m.sortKit),
    (e: unknown) => {
      loading = null; // a failed fetch is tried again by the next list that mounts
      throw e;
    },
  );
  return loading;
}

/** The kit a shell list draws with: the static one until the drag code has
 *  loaded (fetched right after the first paint), then the real one. */
export function useSortKit(): SortKit {
  const [kit, setKit] = useState<SortKit>(() => loaded ?? staticSortKit);
  useEffect(() => {
    if (kit.draggable) return;
    let live = true;
    // quiet: without the drag code the rows still read and open; only reordering waits, and the next mount retries.
    void loadSortKit().then((k) => { if (live) setKit(k); }).catch(() => {});
    return () => { live = false; };
  }, [kit.draggable]);
  return kit;
}
