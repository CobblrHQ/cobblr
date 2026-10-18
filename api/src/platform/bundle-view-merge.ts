// What an update does to a bundle's view a person has changed.
//
// A bundle's view lives in the workspace as the person has it (the row) beside
// the view as the bundle last installed it (the base). An update brings the
// bundle's new version of the view (the incoming). Three copies, compared one
// setting at a time (the name, the layout, whether it is pinned or the default,
// and each top-level key of its configuration: columns, sort, filter, grouping):
//
//   the person did not touch it            -> the update's value lands
//   the person changed it, the update did not -> the person's value stays
//   both changed it to the same thing         -> that value
//   both changed it to different things       -> a conflict: the person's stays
//                                                unless they take the update's
//
// Pure, so the rule is judged without a database.

export interface BundleViewState {
  name: string;
  view_type: string;
  is_default: boolean;
  pinned: boolean;
  config: Record<string, unknown>;
}

const CONFIG = "config.";

/** Key order must not make two equal values look different. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function slotsOf(v: BundleViewState): Map<string, unknown> {
  const out = new Map<string, unknown>([
    ["name", v.name],
    ["view_type", v.view_type],
    ["is_default", v.is_default],
    ["pinned", v.pinned],
  ]);
  for (const [k, val] of Object.entries(v.config ?? {})) if (val !== undefined) out.set(`${CONFIG}${k}`, val);
  return out;
}

function fromSlots(slots: Map<string, unknown>, fallback: BundleViewState): BundleViewState {
  const config: Record<string, unknown> = {};
  for (const [k, val] of slots) if (k.startsWith(CONFIG)) config[k.slice(CONFIG.length)] = val;
  return {
    name: (slots.get("name") as string | undefined) ?? fallback.name,
    view_type: (slots.get("view_type") as string | undefined) ?? fallback.view_type,
    is_default: (slots.get("is_default") as boolean | undefined) ?? fallback.is_default,
    pinned: (slots.get("pinned") as boolean | undefined) ?? fallback.pinned,
    config,
  };
}

/** The settings a person changed on this view since the bundle installed it. */
export function viewEdits(current: BundleViewState, base: BundleViewState): string[] {
  const cur = slotsOf(current);
  const was = slotsOf(base);
  const keys = new Set([...cur.keys(), ...was.keys()]);
  return [...keys].filter((k) => !same(cur.get(k), was.get(k))).sort();
}

export interface ViewMerge {
  /** The view after the update. */
  next: BundleViewState;
  /** What the person had changed (kept, or in conflict). */
  edited: string[];
  /** Settings both the person and the update changed, to different things. */
  conflicts: string[];
}

/** `takeTheirs`: settings (or "*" for all) where the person took the update's value. */
export function mergeBundleView(
  current: BundleViewState,
  base: BundleViewState,
  incoming: BundleViewState,
  takeTheirs: ReadonlySet<string> = new Set(),
): ViewMerge {
  const cur = slotsOf(current);
  const was = slotsOf(base);
  const inc = slotsOf(incoming);
  const keys = new Set([...cur.keys(), ...was.keys(), ...inc.keys()]);
  const out = new Map<string, unknown>();
  const edited: string[] = [];
  const conflicts: string[] = [];
  for (const k of [...keys].sort()) {
    const mine = cur.get(k);
    const theirs = inc.get(k);
    const youChanged = !same(mine, was.get(k));
    const updateChanged = !same(theirs, was.get(k));
    let value: unknown;
    if (!youChanged) value = theirs;
    else {
      edited.push(k);
      if (!updateChanged || same(mine, theirs)) value = mine;
      else {
        conflicts.push(k);
        value = takeTheirs.has("*") || takeTheirs.has(k) ? theirs : mine;
      }
    }
    if (value !== undefined) out.set(k, value);
  }
  return { next: fromSlots(out, incoming), edited, conflicts };
}

/** A setting as a person reads it. */
export function settingWords(slot: string): string {
  if (slot.startsWith(CONFIG)) return slot.slice(CONFIG.length).replace(/_/g, " ");
  return { name: "name", view_type: "layout", is_default: "default", pinned: "pinned" }[slot] ?? slot;
}

/** One side of a conflict, a line per setting. */
export function describeSettings(state: BundleViewState, slots: readonly string[]): string[] {
  const all = slotsOf(state);
  return slots.map((s) => {
    const v = all.get(s);
    const text = v === undefined ? "not set" : typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : stable(v);
    return `${settingWords(s)}: ${text}`;
  });
}
