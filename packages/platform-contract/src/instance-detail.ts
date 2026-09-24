// The instance-detail-route map + the detail-path DECISION — pure and DB-free, so
// it's unit-testable AND shared by every detail-path resolver (the QR token route,
// the scan registry, search). Those were three hand-kept copies that drifted: the
// QR resolver ignored the entity's instance and sent a Vehicle (an assets instance)
// to the empty base /assets/<id> page. One decision here kills that whole class.
//
// In the contract, not the api, because the web asks the reverse question of
// the same map: does THIS url address one item? A collection page that answers
// it from its own list of paths drifts from the links the api hands out, and an
// item link then opens a gallery (#3583).

/** Per-item detail route for a module's NAMED instances, `{id}`-templated. A module
 *  here has a per-item instance detail (a path segment or a ?<noun>=<id> deep-link);
 *  a module NOT here has no per-item instance page, so its instance items fall back
 *  to the base kind route. Add a module only once its instance UI mounts a real
 *  per-item route. */
export const INSTANCE_ITEM_DETAIL: Record<string, (instanceName: string) => string> = {
  projects: (n) => `/instances/${n}/{id}`,
  inventory: (n) => `/instances/${n}/items/{id}`,
  // assets + machines open an instance item's detail in-place via a ?<noun>=<id>
  // deep-link (AssetsPage/MachinesPage: local-state detail, deep-linkable). Without
  // these, a printed QR for a Vehicle (assets instance) or a 3D Printer (machines
  // instance) resolved to the empty BASE page and 404'd — the bug this fixes.
  assets: (n) => `/instances/${n}?asset={id}`,
  machines: (n) => `/instances/${n}?machine={id}`,
  // RecordsPage opens an instance record from ?record=<id> the same way; with no
  // entry a Bookshelf-style records collection handed out links to its bare list.
  records: (n) => `/instances/${n}?record={id}`,
};

/**
 * Does this url, on a module's instance page, address ONE item rather than the
 * collection? Read from the same templates the links are built from, so the
 * page and the links cannot disagree.
 *
 * `subPath` is what follows the instance (`items/<id>`, `settings`, ``), and
 * `search` the query string. A path template matches when the url has the
 * template's path after the instance; a query template (`?asset={id}`) matches
 * when the url carries that parameter.
 */
export function addressesInstanceItem(module: string, url: { subPath: string; search: string }): boolean {
  const tmpl = INSTANCE_ITEM_DETAIL[module];
  if (!tmpl) return false;
  const built = tmpl("\u0000");
  const [pathPart = "", queryPart] = built.split("?");
  if (queryPart) {
    const key = queryPart.split("=")[0] ?? "";
    return !!key && new URLSearchParams(url.search).has(key);
  }
  // What comes between the instance and the id: "items/" for inventory, ""
  // for a module whose id follows the instance directly (projects).
  const itemPath = pathPart.replace(/^\/instances\/\u0000\/?/, "").replace(/\{id\}$/, "");
  const sub = url.subPath.replace(/^\/+|\/+$/g, "");
  // A bare "items" is every module's alias for the list itself.
  if (!sub || sub === "items") return false;
  return itemPath ? sub.startsWith(itemPath) && sub.length > itemPath.length : !sub.includes("/");
}

/** The ONE decision for a resolved entity's detail path, so every resolver agrees.
 *  Priority: the entity's own `detailUrl` → a NAMED instance's per-item route →
 *  the kind's base `detail_route`. `instance` must already be the named
 *  (non-default) collection, or null. */
export function resolveDetailPath(opts: {
  kind: string;
  id: string;
  instance: string | null;
  detailUrl: string | null;
  baseDetailRoute: string | null;
}): string | undefined {
  if (opts.detailUrl) return opts.detailUrl;
  const module = opts.kind.split(":")[0] ?? "";
  const perItem = opts.instance ? INSTANCE_ITEM_DETAIL[module] : undefined;
  if (opts.instance && perItem) return perItem(opts.instance).replace("{id}", opts.id);
  return opts.baseDetailRoute ? opts.baseDetailRoute.replace("{id}", opts.id) : undefined;
}

/** The web door that opens any record from its kind and id alone: it asks the
 *  server where the record lives (detailPathForEntity) and goes there. */
export const OPEN_RECORD_ROUTE = "/open/:kind/:id";

export function openRecordPath(kind: string, id: string): string {
  return `/open/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/**
 * Where a link to a record goes, for a surface holding a row of it. The row's
 * own `detailUrl` wins: the server built it from the record's collection. A
 * row that names only the BASE kind of a module with collections
 * ("inventory:part" for an item filed in Home Inventory) cannot say which
 * collection, and the base route would open "part not found" (#3623), so it
 * goes through the open door, which asks. Any other kind uses its registry
 * template: an instance kind's template already names its collection, and a
 * module without collections has one address.
 *
 * Surfaces never splice a template themselves; lint:record-links-from-the-map
 * holds that.
 */
export function recordHref(
  ref: { kind: string; id: string; detailUrl?: string | null },
  template: string | null | undefined,
): string | null {
  if (ref.detailUrl) return ref.detailUrl;
  const [module = "", type = ""] = ref.kind.split(":");
  if (INSTANCE_ITEM_DETAIL[module] && type !== "item") return openRecordPath(ref.kind, ref.id);
  return template ? template.replace("{id}", ref.id) : null;
}
