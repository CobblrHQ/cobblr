// Every write that lands in a workspace is told here, whichever client sent
// it: the web app's api client and each module's own (inventory, lists,
// projects…), which fetch for themselves. Listeners then refresh what the
// write could have moved, decided once, not remembered by each write.
//
// The stock and place views are the reason this is shared (#4431, #4440):
// "Use some" refreshed the item's rows but not the total above them, and
// "Move everything" emptied a shelf's list but left its bin counter and its
// Stock here showing the thing that had gone. Each write listed by hand the
// caches it refreshed, and those lists drifted from the screens reading
// them. lint:module-writes-are-told holds every module client to this door.
import type { QueryClient } from "@tanstack/react-query";

export type WorkspaceWriteListener = (slug: string, path: string) => void;
const listeners = new Set<WorkspaceWriteListener>();
const deletedRecordListeners = new Set<(record: { slug: string; id: string }) => void>();

export function subscribeDeletedRecord(listener: (record: { slug: string; id: string }) => void): () => void {
  deletedRecordListeners.add(listener);
  return () => { deletedRecordListeners.delete(listener); };
}

export function subscribeWorkspaceWrite(listener: WorkspaceWriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A successful write to `path` (`/orgs/<slug>/…`, absolute `/api/v1/…` or a
 *  full URL). A path outside a workspace is not one. */
export function noteWorkspaceWrite(path: string, response?: Pick<Response, "headers">): void {
  let p = path;
  try {
    if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  } catch {
    return;
  }
  p = p.replace(/^\/api\/v1(?=\/)/, "");
  const m = /^\/orgs\/([^/?#]+)/.exec(p);
  if (!m) return;
  const slug = decodeURIComponent(m[1]!);
  listeners.forEach((l) => l(slug, p));
  const id = response?.headers?.get("x-cobblr-deleted-record");
  if (id && !/\/modules\/(core-files|core-locations|core-tags)\//.test(p)) deletedRecordListeners.forEach((listener) => listener({ slug, id }));
}

/** The caches that show how much there is or where things are kept. Every
 *  write marks them stale, and the ones on screen read again. */
export const STOCK_VIEW_KEYS = [
  "inventory-holdings",
  "inventory-part",
  "inventory-consumption",
  "inventory-units",
  "inventory-family",
  "stock-at",
  "bin-contents",
  "location-contents",
  "placement-contents",
  "location",
  "locations",
  "core-locations",
] as const;

/** Lists whose numbers the stepper patches as it steps: marked stale, read
 *  again when next shown, never refetched under a person stepping fast. */
export const STOCK_LIST_KEYS = ["inventory-parts", "kind-list", "view-data"] as const;

const head = (key: readonly unknown[]) => (typeof key[0] === "string" ? key[0] : "");

export function refreshStockViews(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ predicate: (q) => (STOCK_VIEW_KEYS as readonly string[]).includes(head(q.queryKey)) }),
    qc.invalidateQueries({ predicate: (q) => (STOCK_LIST_KEYS as readonly string[]).includes(head(q.queryKey)), refetchType: "none" }),
  ]);
}
