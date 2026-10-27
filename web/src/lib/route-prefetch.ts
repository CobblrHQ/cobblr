// Fetch a section's code before it is opened, so a lazily loaded section still
// opens at once (#4945).
//
// Every section of the app is its own chunk, fetched the first time it is
// opened. On a desktop that would add a round trip to the first click on each
// nav row, so a person's intent starts the fetch instead: pointing at a link,
// focusing it, or touching it. And once the page has settled, on a desktop on
// a connection that is not metered, the sections the nav links to are fetched
// in the background. A phone on data, or a browser that asked to save data,
// fetches nothing it was not asked for.
//
// The loaders below are the SAME import() calls App.tsx gives React.lazy, so
// the bundler hands both one chunk and a prefetched section is simply already
// there when its route renders. One listener on the document covers every
// link in every nav; nothing has to remember to wire a row.

type Loader = () => Promise<unknown>;

/** Path prefix (inside the workspace) → the chunk its route renders. The
 *  longest matching prefix wins. */
export const ROUTE_CHUNKS: ReadonlyArray<readonly [string, Loader]> = [
  ["/inventory", () => import("@cobblr/inventory/ui")],
  ["/labels", () => import("@cobblr/labels/ui")],
  ["/projects", () => import("@cobblr/projects/ui")],
  ["/lists", () => import("@cobblr/lists/ui")],
  ["/knowledge", () => import("@cobblr/knowledge/ui")],
  ["/builds", () => import("@cobblr/builds/ui")],
  ["/sales", () => import("@cobblr/sales/ui")],
  ["/tracking", () => import("@cobblr/tracking/ui")],
  ["/instances", () => import("../pages/InstancePage")],
  ["/machines", () => import("../pages/MachinesPage")],
  ["/lent-out", () => import("../pages/LentOutPage")],
  ["/assets", () => import("../pages/AssetsPage")],
  ["/records", () => import("../pages/RecordsPage")],
  ["/purchases", () => import("../pages/PurchasesPage")],
  ["/scan", () => import("../pages/ScanPage")],
  ["/search", () => import("../pages/SearchPage")],
  ["/locations", () => import("../pages/LocationsPage")],
  ["/tags", () => import("../pages/TagsPage")],
  ["/files", () => import("../pages/FilesPage")],
  ["/views", () => import("../pages/ViewsPage")],
  ["/apps", () => import("../pages/AllAppsPage")],
  ["/calendar", () => import("../pages/CalendarPage")],
  ["/vault", () => import("../pages/VaultPage")],
  ["/discussion", () => import("../pages/DiscussionInboxPage")],
  ["/suggestions", () => import("../pages/SuggestionsPage")],
  ["/wires", () => import("../pages/BindingsPage")],
  ["/actions", () => import("../pages/ActionsPage")],
  ["/bundles", () => import("../pages/BundlesPage")],
  ["/fields", () => import("../pages/FieldsAndFormsPage")],
  ["/activity", () => import("../pages/ActivityPage")],
  ["/maintenance", () => import("../pages/MaintenancePage")],
  ["/build", () => import("../pages/BuildPage")],
  ["/digifab", () => import("../pages/DigifabPage")],
  ["/makes", () => import("../pages/MakesPage")],
  ["/bricklink-connector", () => import("../pages/BrickLinkPage")],
  ["/configuration", () => Promise.all([import("../components/ConfigurationLayout"), import("../pages/ConfigurationPage")])],
  ["/me", () => Promise.all([import("../components/AccountLayout"), import("../pages/MeProfilePage")])],
  ["/", () => import("../pages/Dashboard")],
];

/** Routes deliberately left out of the table, each with why: none of them is
 *  a section a person opens from inside the workspace, so there is no intent
 *  to answer. The drift test reads this list. */
export const NOT_PREFETCHED: Readonly<Record<string, string>> = {
  "/admin": "the operator console, outside every workspace",
  "/view-as": "an operator's door into another account, opened from a link",
  "/pair": "a phone arriving from a pairing QR code",
  "/changelog": "opened from a link or the menu's What's new, a page read once",
  "/qr": "a label scanned with a phone camera, arriving from outside",
  "/a": "an action label scanned with a phone camera, arriving from outside",
};

/** Any other single-segment path is a collection (an instance's short path). */
const instanceChunk: Loader = () => import("../pages/InstancePage");

const started = new Set<Loader>();

/** The loader for a path inside the workspace, or null for none. */
export function chunkFor(path: string): Loader | null {
  const clean = path.split(/[?#]/)[0] || "/";
  let best: readonly [string, Loader] | null = null;
  for (const entry of ROUTE_CHUNKS) {
    const [prefix] = entry;
    const hit = prefix === "/" ? clean === "/" : clean === prefix || clean.startsWith(`${prefix}/`);
    if (hit && (!best || prefix.length > best[0].length)) best = entry;
  }
  if (best) return best[1];
  return /^\/[^/]+\/?$/.test(clean) ? instanceChunk : null;
}

/** Start fetching a path's chunk; a second ask for the same chunk is free. */
export function prefetchRoute(path: string): void {
  const load = chunkFor(path);
  if (!load || started.has(load)) return;
  started.add(load);
  load().catch(() => started.delete(load));
}

/** The in-workspace path a link points at, or null when it leaves the app. */
function workspacePath(a: HTMLAnchorElement, basename: string): string | null {
  if (a.target && a.target !== "_self") return null;
  let url: URL;
  try {
    url = new URL(a.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (!url.pathname.startsWith(basename)) return null;
  return url.pathname.slice(basename.length) || "/";
}

/** A browser that should not fetch ahead: data saver on, or a slow link. */
function shouldHoldBack(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c?.saveData || /(^|-)2g$|^3g$/.test(c?.effectiveType ?? "");
}

/** Install the intent listeners for a workspace mounted at `basename`
 *  ("/w/<slug>"), and the idle fetch of the nav's sections. Returns the
 *  uninstall. */
export function installRoutePrefetch(basename: string): () => void {
  const onIntent = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const path = workspacePath(a, basename);
    if (path) prefetchRoute(path);
  };
  document.addEventListener("pointerover", onIntent, { passive: true });
  document.addEventListener("focusin", onIntent);
  document.addEventListener("touchstart", onIntent, { passive: true });

  let idle: number | null = null;
  const desktop = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
  if (desktop && !shouldHoldBack()) {
    const run = () => {
      for (const a of document.querySelectorAll<HTMLAnchorElement>("nav a[href], aside a[href]")) {
        const path = workspacePath(a, basename);
        if (path) prefetchRoute(path);
      }
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    // Settled first: the page's own data, then the sections a person may open.
    idle = window.setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 4000 }) : run()), 3000);
  }
  return () => {
    document.removeEventListener("pointerover", onIntent);
    document.removeEventListener("focusin", onIntent);
    document.removeEventListener("touchstart", onIntent);
    if (idle !== null) clearTimeout(idle);
  };
}
