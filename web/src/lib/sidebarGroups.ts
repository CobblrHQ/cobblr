// The sidebar's own groups, as a list of labelled names in the order the
// sidebar draws them: "Collections" and "Tools" when it has grown into them,
// a bundle's group ("Kitchen") or a heading you made, a module with its
// specialisations under it ("Machines"). The apps page reads its "in your
// sidebar" apps through this, so the page and the nav read as one map
// (#4046). Pure: the same inputs the sidebar draws from.
import { groupNavRows } from "../components/nav-groups";
import { HEADING_PREFIX, NAVGROUP_PREFIX } from "../components/useNavModules";

interface NavRow {
  name: string;
  displayName: string;
  operates_on?: string[] | null;
  nav_kind?: "collection" | "tool" | null;
}

export interface SidebarGroup {
  label: string;
  /** The nav row names under this label: tops, their children, members. */
  names: string[];
}

/** The label a flat sidebar's rows go under (a fresh workspace has no groups). */
export const FLAT_GROUP = "In your sidebar";

export function sidebarGroups(
  tops: readonly NavRow[],
  children: ReadonlyMap<string, readonly { name: string }[]>,
  instanceGroups: ReadonlyMap<string, { label: string; members: readonly { name: string }[] }>,
  doorNames: ReadonlySet<string>,
  opts: { homeRow: boolean; flatLabel?: string },
): SidebarGroup[] {
  const out: SidebarGroup[] = [];
  const bucket = (label: string): SidebarGroup => {
    let b = out.find((g) => g.label === label);
    if (!b) {
      b = { label, names: [] };
      out.push(b);
    }
    return b;
  };
  const walk = (list: readonly NavRow[], plainLabel: string) => {
    for (const t of list) {
      const kids = (children.get(t.name) ?? []).map((k) => k.name);
      if (t.name.startsWith(NAVGROUP_PREFIX)) {
        const g = instanceGroups.get(t.name);
        bucket(g?.label || t.displayName).names.push(...(g?.members ?? []).map((m) => m.name));
      } else if (t.name.startsWith(HEADING_PREFIX)) {
        bucket(t.displayName).names.push(...kids);
      } else if (kids.length) {
        bucket(t.displayName).names.push(t.name, ...kids);
      } else {
        bucket(plainLabel).names.push(t.name);
      }
    }
  };
  const groups = groupNavRows(tops, doorNames, opts);
  if (groups.grouped) {
    walk(groups.collections, "Collections");
    walk(groups.tools, "Tools");
  } else {
    walk(tops, opts.flatLabel ?? FLAT_GROUP);
  }
  return out.filter((g) => g.names.length > 0);
}
