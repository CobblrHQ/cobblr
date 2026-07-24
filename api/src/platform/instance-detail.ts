// The instance-detail-route map + the detail-path DECISION — pure and DB-free, so
// it's unit-testable AND shared by every detail-path resolver (the QR token route,
// the scan registry, search). Those were three hand-kept copies that drifted: the
// QR resolver ignored the entity's instance and sent a Vehicle (an assets instance)
// to the empty base /assets/<id> page. One decision here kills that whole class.

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
};

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
