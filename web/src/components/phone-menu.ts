// The phone menu's order (#5389): what you keep, then the tools.
//
// A row is either a BLOCK (a heading, a bundle's nav group, a module with
// children: a header and its rows) or LOOSE (one destination). The menu used to
// flow every row through one two-column grid, so a group's last row carried on
// into whatever came next ("Bookshelf" and "Mugs" sat under MACHINES). Here a
// block is drawn whole, and the loose rows of a section come after its blocks
// under a header of their own, so no row ever sits under someone else's header.
//
// The collections/tools split is the sidebar's (nav-groups.ts), past the same
// threshold, so the two navs never disagree about where Labels lives.

export interface PhoneMenuSection<T> {
  /** The header over the loose rows, or null when nothing above could claim them. */
  looseTitle: string | null;
  blocks: T[];
  loose: T[];
}

export function phoneMenuSections<T extends { name: string }>(
  tops: readonly T[],
  o: { isBlock: (t: T) => boolean; isTool: (t: T) => boolean; grouped: boolean },
): PhoneMenuSection<T>[] {
  const section = (list: readonly T[], title: string, always = false): PhoneMenuSection<T> => {
    const blocks = list.filter(o.isBlock);
    const loose = list.filter((t) => !o.isBlock(t));
    return { blocks, loose, looseTitle: loose.length && (always || blocks.length) ? title : null };
  };
  const sections = o.grouped
    ? [section(tops.filter((t) => !o.isTool(t)), "Collections"), section(tops.filter(o.isTool), "Tools", true)]
    : [section(tops, tops.every((t) => !o.isTool(t)) ? "Collections" : "Other")];
  return sections.filter((s) => s.blocks.length + s.loose.length > 0);
}

/** A header that is only a word, with no row under it before the next header
 *  or the end, is an empty section: it goes, so it draws no divider and keeps
 *  no height (#6334). A header that is itself a link stays. */
export function withoutEmptySections<T extends { header?: boolean; door?: boolean }>(entries: T[]): T[] {
  return entries.filter((e, i) => !e.header || e.door || (entries[i + 1] !== undefined && !entries[i + 1]!.header));
}
