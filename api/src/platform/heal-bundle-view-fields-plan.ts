// Which bundle-shipped views get the shipped bundle's current definition
// (heal-bundle-view-fields.ts), apart from the database so a test can hold it.

export interface ShippedView {
  entity_kind: string;
  name: string;
  config: Record<string, unknown>;
}

export interface ViewHeal extends ShippedView {
  /** What the older bundle shipped, and the row must still hold. */
  from: Record<string, unknown>;
}

type Node = Record<string, unknown>;
const list = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : []);
const isView = (v: Node) => typeof v.name === "string" && typeof v.entity_kind === "string" && !!v.config && typeof v.config === "object";

/** Every view a manifest seeds, as an install of it with these features on
 *  writes them: a table's views under `<instance_name>:item`. `edit` may
 *  return a new config for a view, and the manifest comes back with it. */
export function mapManifestViews(
  manifest: unknown,
  enabledFeatures: readonly string[],
  edit: (view: ShippedView) => Record<string, unknown> | undefined = () => undefined,
): { views: ShippedView[]; manifest: unknown } {
  const views: ShippedView[] = [];
  const visit = (vs: unknown, instance?: string): Node[] =>
    list(vs).map((v) => {
      if (!isView(v)) return v;
      const view = { entity_kind: instance ? `${instance}:item` : String(v.entity_kind), name: String(v.name), config: v.config as Record<string, unknown> };
      views.push(view);
      const next = edit(view);
      return next ? { ...v, config: next } : v;
    });
  const instances = (is: unknown) => list(is).map((i) => ("saved_views" in i ? { ...i, saved_views: visit(i.saved_views, String(i.instance_name)) } : i));
  const m = (manifest ?? {}) as Node;
  const out: Node = { ...m };
  if ("saved_views" in m) out.saved_views = visit(m.saved_views);
  if ("provides_instances" in m) out.provides_instances = instances(m.provides_instances);
  if ("features" in m) {
    out.features = list(m.features).map((f) => {
      if (!enabledFeatures.includes(String(f.key))) return f;
      const g: Node = { ...f };
      if ("saved_views" in f) g.saved_views = visit(f.saved_views);
      if ("provides_instances" in f) g.provides_instances = instances(f.provides_instances);
      return g;
    });
  }
  return { views, manifest: out };
}

/** The fields a view's grouping, sort and filter name. */
export function fieldsNamed(config: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim().replace(/^-/, ""));
    else if (v && typeof v === "object" && typeof (v as Node).field === "string") out.add(String((v as Node).field));
  };
  for (const g of Array.isArray(config.group_by) ? config.group_by : [config.group_by]) add(g);
  if (Array.isArray(config.sort)) config.sort.forEach(add);
  add(config.sort_by);
  if (config.filter && typeof config.filter === "object" && !Array.isArray(config.filter)) {
    // Keys with a leading underscore and the stock flag are the platform's
    // own filters (`_tag`, hide_unavailable), not fields.
    for (const k of Object.keys(config.filter)) if (!k.startsWith("_") && k !== "hide_unavailable") out.add(k);
  }
  for (const p of list(config.where)) {
    add(p.col);
    add(p.ref_col);
  }
  return [...out];
}

/** The same JSON whatever order its keys were written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Node)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sameConfig = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The views to heal. Pure. A view qualifies when the bundle that seeded it
 *  now ships it differently, what the install shipped names a field its kind
 *  does not have, and what ships now names only fields it does. `fieldsOf`
 *  answers a kind's fields in this workspace, or undefined when it cannot. */
export function planViewHeals(
  installed: readonly ShippedView[],
  current: readonly ShippedView[],
  fieldsOf: (kind: string) => ReadonlySet<string> | undefined,
): ViewHeal[] {
  const now = new Map(current.map((v) => [`${v.entity_kind}\u0000${v.name}`, v]));
  const heals: ViewHeal[] = [];
  for (const was of installed) {
    const next = now.get(`${was.entity_kind}\u0000${was.name}`);
    if (!next || sameConfig(was.config, next.config)) continue;
    const fields = fieldsOf(was.entity_kind);
    if (!fields) continue;
    const broken = fieldsNamed(was.config).some((f) => !fields.has(f));
    const whole = fieldsNamed(next.config).every((f) => fields.has(f));
    if (broken && whole) heals.push({ entity_kind: was.entity_kind, name: was.name, config: next.config, from: was.config });
  }
  return heals;
}
