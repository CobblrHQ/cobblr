// The sidebar's middle, once it has grown: collections and tools.
//
// A fresh workspace is three rows (Home, Locations, Scan Inbox) and reads fine
// flat. A workspace with ten rows does not: the places a person keeps things
// (Yarn, Inventory, the pantry) and the places they go to DO something
// (Locations, the Scan Inbox, Labels, Digital Fabrication) are one undifferen-
// tiated list, and the eye has to re-sort it on every glance. So past a
// threshold the sidebar shows two quiet stem groups, the way an instance
// nav-group already renders (a small label, the rows under it).
//
// The split is what modules declare, not a list kept here. A manifest can say
// it outright (`navKind`); otherwise it is derived: a door (`nav.primary`,
// the rows navDoorsOf makes) is a tool; a module that OPERATES ON other
// modules' things (`operates_on` non-empty: labels, digifab) is a tool;
// everything else, including every instance and heading, is a collection.
// The derivation alone filed Purchases under tools on the first rig run
// (it operates on inventory, and is still a collection of orders), which is
// why the explicit word exists (design review #2920, 2026-09-13).
//
// That is only the DEFAULT. A person who keeps Inventory with their
// collections drags it there, and the move is saved per device
// (`cobblr:nav-placement`, readNavPlacement) and wins from then on (#4374).
// Order inside a group is the same per-device drag order as before, and
// nothing reorders itself by usage: a row that moves on its own is a row you
// cannot find again.

export const NAV_GROUP_THRESHOLD = 6;

export type NavGroupName = "collections" | "tools";

export interface NavGroups<T> {
  /** False under the threshold, or when one side would be empty: a single
   *  labelled group is a label over the whole list, which says nothing. */
  grouped: boolean;
  collections: T[];
  tools: T[];
}

export function isNavTool(
  row: { name: string; operates_on?: string[] | null; nav_kind?: "collection" | "tool" | null },
  doorNames: ReadonlySet<string>,
  placement: Readonly<Record<string, NavGroupName>> = {},
): boolean {
  const chosen = placement[row.name];
  if (chosen) return chosen === "tools";
  if (row.nav_kind) return row.nav_kind === "tool";
  return doorNames.has(row.name) || (row.operates_on?.length ?? 0) > 0;
}

/** Split the rendered tops into the two groups, or say the list stays flat.
 *  `homeRow` counts Home toward the threshold when the nav shows one (a
 *  locked app does not). Order within each group is the order given. */
export function groupNavRows<T extends { name: string; operates_on?: string[] | null; nav_kind?: "collection" | "tool" | null }>(
  tops: readonly T[],
  doorNames: ReadonlySet<string>,
  opts: { homeRow: boolean; placement?: Readonly<Record<string, NavGroupName>> },
): NavGroups<T> {
  const rows = tops.length + (opts.homeRow ? 1 : 0);
  const tools = tops.filter((t) => isNavTool(t, doorNames, opts.placement));
  const collections = tops.filter((t) => !isNavTool(t, doorNames, opts.placement));
  const grouped = rows >= NAV_GROUP_THRESHOLD && tools.length > 0 && collections.length > 0;
  return { grouped, collections, tools };
}

/** Which group a name belongs to, or null when the name is not a top here
 *  (a child row belongs to its parent's group for the purpose of a drag). */
export function navGroupOf<T extends { name: string }>(
  groups: NavGroups<T>,
  name: string,
  childrenOf: (top: string) => readonly string[],
): NavGroupName | null {
  for (const [g, list] of [["collections", groups.collections], ["tools", groups.tools]] as const) {
    for (const t of list) {
      if (t.name === name || childrenOf(t.name).includes(name)) return g;
    }
  }
  return null;
}

/** What a drop does to the groups: nothing (same group, or ungrouped), or
 *  the TOP that moved and the group it now belongs to. A child dropped among
 *  another group's rows takes nothing with it: it belongs to its parent, so
 *  the move is its parent's to make. */
export function groupMoveOf<T extends { name: string }>(
  groups: NavGroups<T>,
  moved: string,
  over: string,
  childrenOf: (top: string) => readonly string[],
): { name: string; to: NavGroupName } | null {
  if (!groups.grouped) return null;
  const a = navGroupOf(groups, moved, childrenOf);
  const b = navGroupOf(groups, over, childrenOf);
  if (a === null || b === null || a === b) return null;
  const isTop = [...groups.collections, ...groups.tools].some((t) => t.name === moved);
  return isTop ? { name: moved, to: b } : null;
}
