// The Vivaldi-style LEFT SIDEBAR rendering of the module nav — the same
// hierarchy useNavModules feeds the top navbar, but expanded in place:
// every child that lives in a hover popover up top is simply indented
// here, always visible, no dropdowns and no "more" fold (a column
// scrolls; a row can't). Skinny on purpose (w-52).
//
// Mode + pinning live in localStorage (see AppLayout): the tiny panel
// icon left of the wordmark flips top↔side; the pin in the sidebar
// footer flips pinned↔auto-hide.

import type { ReactNode } from "react";
import { MoreAppsDoor } from "./MoreAppsDoor";
import { NavLink, useLocation } from "react-router-dom";
import { useSortKit } from "./sort-kit-static";
import { dropOnSidebar } from "./navReorder";
import { ArrowLeft } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { isConfigurationPath } from "../lib/configuration-nav";
import { ConfigSidebarBody } from "./ConfigurationLayout";
import { NavCountBadge } from "./NavCountBadge";
import { NavSplitRow, NavRowMenu } from "./NavSplitRow";
import { useNavBadges } from "./useNavBadges";
import { groupNavRows } from "./nav-groups";
import {
  useNavModules,
  HEADING_PREFIX,
  NAVGROUP_PREFIX,
  INSTANCE_PREFIX,
  surfaceTops,
} from "./useNavModules";

// A flex row, not a block: a row can carry a live count (the Scan Inbox's
// pending captures) after its label, and the label alone truncates.
const linkCls = ({ isActive }: { isActive: boolean }) =>
  "flex items-center gap-2 px-3 py-1.5 rounded text-sm transition " +
  (isActive
    ? "text-accent font-semibold bg-subtle dark:bg-slate-800/60"
    : "text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40");

const childCls = ({ isActive }: { isActive: boolean }) =>
  "flex items-center gap-2 pl-6 pr-3 py-1 rounded text-[13px] transition truncate " +
  (isActive
    ? "text-accent font-semibold bg-subtle dark:bg-slate-800/60"
    : "text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40");

export function SidebarNav({
  head,
  foot,
  controls,
}: {
  /** Full-sidebar mode: brand/workspace block above the nav (hosts `controls`). */
  head?: ReactNode;
  /** Full-sidebar mode: the Scan/search/bell/AI/account cluster below the nav. */
  foot?: ReactNode;
  /** The pin + top-bar icon pair. Rendered top-right: inside `head` when one
   *  is passed, else in a slim strip above the nav. */
  controls?: ReactNode;
}) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const appMode = !!activeOrg?.app_mode;
  const { pathname } = useLocation();
  const { tops: allVisibleTops, childrenByParent: children, instanceGroups, doorNames, placement } = useNavModules(activeSlug);
  const tops = surfaceTops(allVisibleTops, appMode);
  const rowCandidates = tops.flatMap((t) => instanceGroups.get(t.name)?.members ?? (t.name.startsWith(INSTANCE_PREFIX) ? [t] : []));
  const badges = useNavBadges(activeSlug);
  // Past a handful of rows the middle splits into collections and tools
  // (nav-groups.ts); under it the list is flat, exactly as a fresh workspace
  // has always seen it.
  const groups = groupNavRows(tops, doorNames, { homeRow: !appMode, placement });
  // HOOKS STAY ABOVE the config-fold early return — a hook below it renders
  // in one branch but not the other, and React throws "Rendered more hooks
  // than during the previous render" the moment you navigate between them.
  // Drag-to-reorder arrives after the first paint (sort-kit.tsx): until then
  // the same rows draw without it. The sensors (move 8px with a mouse, hold
  // 250ms with a finger) live in the kit.
  const K = useSortKit();

  // Configuration fold (the author, 2026-07-03): on a configuration-family route the
  // sidebar BECOMES the configuration panel — two sidebars never stack. A
  // quiet "workspace" row at the top swaps back to the module nav (any module
  // link would too); leaving the config routes restores it automatically.
  if (isConfigurationPath(pathname)) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {head}
        {!head && controls && <div className="shrink-0 flex justify-end px-2 pt-1.5">{controls}</div>}
        <NavLink
          to="/"
          className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line dark:border-slate-800 text-[13px] text-muted dark:text-slate-400 hover:text-accent transition"
        >
          <ArrowLeft size={13} /> workspace
        </NavLink>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          <ConfigSidebarBody />
        </div>
        {foot}
      </div>
    );
  }

  const childTo = (parentName: string, k: { name: string }) =>
    k.name.startsWith(INSTANCE_PREFIX)
      ? `/${k.name.slice(INSTANCE_PREFIX.length)}`
      : parentName.startsWith(HEADING_PREFIX)
        ? `/${k.name}`
        : `/${parentName}?lens=${k.name}`;

  const renderTop = (m: (typeof tops)[number], handle: Record<string, unknown>) => {
          // Instance nav-group: quiet stem label, members indented.
          if (m.name.startsWith(NAVGROUP_PREFIX)) {
            const g = instanceGroups.get(m.name);
            if (!g) return null;
            return <NavSplitRow key={m.name} slug={activeSlug} group={g} candidates={rowCandidates} appMode={appMode} handle={handle} />;
          }
          const kids = children.get(m.name) ?? [];
          // A user-defined heading has no page — it's a label over its members.
          if (m.name.startsWith(HEADING_PREFIX)) {
            return (
              <div key={m.name}>
                <div
                  {...handle}
                  className="px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 select-none"
                >
                  {m.displayName}
                </div>
                <K.Group ids={kids.map((k) => k.name)}>
                  {kids.map((k) => (
                    <K.Child key={k.name} id={k.name}>
                      <NavLink to={childTo(m.name, k)} className={childCls}>
                        <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
                        {k.displayName}
                      </NavLink>
                    </K.Child>
                  ))}
                </K.Group>
              </div>
            );
          }
          const to = m.name.startsWith(INSTANCE_PREFIX) ? `/${m.name.slice(INSTANCE_PREFIX.length)}` : `/${m.name}`;
          return (
            <div key={m.name}>
              <div className="flex min-w-0 items-center"><NavLink {...handle} role="link" to={to} className={(state) => linkCls(state) + " min-w-0 flex-1"}>
                <span className="truncate">{m.displayName}</span>
                <NavCountBadge count={badges.get(m.name)} label={m.displayName} className="ml-auto" />
              </NavLink>{m.name.startsWith(INSTANCE_PREFIX) && <NavRowMenu slug={activeSlug} label={m.displayName} members={[m]} candidates={rowCandidates} />}</div>
              <K.Group ids={kids.map((k) => k.name)}>
                {kids.map((k) => (
                  <K.Child key={k.name} id={k.name}>
                    <NavLink to={childTo(m.name, k)} className={childCls}>
                      <span
                        className={
                          "w-1.5 h-1.5 rounded-full shrink-0 " +
                          (k.name.startsWith(INSTANCE_PREFIX) ? "bg-cobble-500" : "bg-moss-500")
                        }
                      />
                      {k.displayName}
                    </NavLink>
                  </K.Child>
                ))}
              </K.Group>
            </div>
          );
  };
  /** The tree as it reads right now: each top, then the children under it.
   *  Both levels are written back together, so the saved order can never say
   *  one thing about a heading and another about its members. */
  const branches = tops.map((t) => ({
    name: t.name,
    children: t.name.startsWith(NAVGROUP_PREFIX)
      ? (instanceGroups.get(t.name)?.members ?? []).map((mem) => mem.name)
      : (children.get(t.name) ?? []).map((k) => k.name),
  }));

  // A row dropped among the other group's rows goes there: the manifest only
  // decides where a row starts (dropOnSidebar).
  const onDrop = (activeId: string, overId: string) => dropOnSidebar(activeSlug, groups, branches, activeId, overId);

  // The end of the collections: every app not in this sidebar, with how many
  // (#3883). A control of its own, not another row nobody reads as a door.
  const allAppsRow = !appMode && (
    <div className="px-1 pt-1.5">
      <MoreAppsDoor />
    </div>
  );
  const homeRow = !appMode && (
    <NavLink to="/" end className={linkCls}>
      <span className="truncate">Home</span>
    </NavLink>
  );
  const sortable = (list: typeof tops) => (
    <K.Group ids={list.map((t) => t.name)}>
      {list.map((m) => (
        <K.Row key={m.name} id={m.name}>
          {(handle) => renderTop(m, handle)}
        </K.Row>
      ))}
    </K.Group>
  );
  // The same quiet stem an instance nav-group uses, so the grown sidebar reads
  // as one vocabulary: a small label, the rows under it.
  const stemCls = "px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 select-none";

  return (
    <div className="flex flex-col h-full min-h-0">
      {head}
      {!head && controls && <div className="shrink-0 flex justify-end px-2 pt-1.5">{controls}</div>}
      <nav data-tour="nav" className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-3 space-y-0.5">
        <K.Root grip="hold" onDrop={onDrop}>
          {groups.grouped ? (
            <>
              <div data-nav-group="collections" className={stemCls}>
                Collections
              </div>
              {homeRow}
              {sortable(groups.collections)}
              {allAppsRow}
              <div data-nav-group="tools" className={stemCls + " pt-3"}>
                Tools
              </div>
              {sortable(groups.tools)}
            </>
          ) : (
            <>
              {homeRow}
              {sortable(tops)}
              {allAppsRow}
            </>
          )}
        </K.Root>
      </nav>
        {foot}
    </div>
  );
}
