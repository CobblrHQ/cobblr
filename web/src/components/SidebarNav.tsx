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
import { useDragClickGuard } from "./useDragClickGuard";
import { NavLink, useLocation } from "react-router-dom";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { writeNavOrder } from "../lib/nav-order";
import { reorderNav } from "./navReorder";
import { ArrowLeft } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { isConfigurationPath } from "../lib/configuration-nav";
import { ConfigSidebarBody } from "./ConfigurationLayout";
import { NavCountBadge } from "./NavCountBadge";
import { useNavBadges } from "./useNavBadges";
import { dragStaysInGroup, groupNavRows } from "./nav-groups";
import {
  useNavModules,
  HEADING_PREFIX,
  NAVGROUP_PREFIX,
  INSTANCE_PREFIX,
  stripNavStem,
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
  const { tops: allVisibleTops, childrenByParent: children, instanceGroups, doorNames } = useNavModules(activeSlug);
  const tops = surfaceTops(allVisibleTops, appMode);
  const badges = useNavBadges(activeSlug);
  // Past a handful of rows the middle splits into collections and tools
  // (nav-groups.ts); under it the list is flat, exactly as a fresh workspace
  // has always seen it.
  const groups = groupNavRows(tops, doorNames, { homeRow: !appMode });
  // HOOKS STAY ABOVE the config-fold early return — a hook below it renders
  // in one branch but not the other, and React throws "Rendered more hooks
  // than during the previous render" the moment you navigate between them.
  // Drag-to-reorder sensors. Two, because the two input devices need opposite
  // rules and one sensor cannot serve both:
  //   mouse  - MOVE 8px to drag. A click that does not travel still navigates.
  //            A hold-to-start here is the thing that "feels very unnatural":
  //            nobody presses and waits on a desktop.
  //   touch  - HOLD 250ms to drag. A finger that moves at once is scrolling
  //            the sidebar, and stealing that for a drag makes the list
  //            unscrollable on a phone.
  // The hold used to apply to both, borrowed from the touch case.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

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
            return (
              <div key={m.name}>
                {/* The LABEL is the group's drag handle. It used to be the whole
                    block, which is why grabbing a member moved the group. */}
                <div
                  {...handle}
                  className="px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 select-none"
                >
                  {g.label}
                </div>
                <SortableContext items={g.members.map((mem) => mem.name)} strategy={verticalListSortingStrategy}>
                  {g.members.map((mem) => (
                    <SortableChild key={mem.name} id={mem.name}>
                      <NavLink to={`/${mem.name.slice(INSTANCE_PREFIX.length)}`} className={childCls}>
                        <span className="w-1.5 h-1.5 rounded-full bg-cobble-500 shrink-0" />
                        {stripNavStem(mem.displayName, g.label)}
                      </NavLink>
                    </SortableChild>
                  ))}
                </SortableContext>
              </div>
            );
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
                <SortableContext items={kids.map((k) => k.name)} strategy={verticalListSortingStrategy}>
                  {kids.map((k) => (
                    <SortableChild key={k.name} id={k.name}>
                      <NavLink to={childTo(m.name, k)} className={childCls}>
                        <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
                        {k.displayName}
                      </NavLink>
                    </SortableChild>
                  ))}
                </SortableContext>
              </div>
            );
          }
          const to = m.name.startsWith(INSTANCE_PREFIX) ? `/${m.name.slice(INSTANCE_PREFIX.length)}` : `/${m.name}`;
          return (
            <div key={m.name}>
              <NavLink {...handle} to={to} className={linkCls}>
                <span className="truncate">{m.displayName}</span>
                <NavCountBadge count={badges.get(m.name)} label={m.displayName} className="ml-auto" />
              </NavLink>
              <SortableContext items={kids.map((k) => k.name)} strategy={verticalListSortingStrategy}>
                {kids.map((k) => (
                  <SortableChild key={k.name} id={k.name}>
                    <NavLink to={childTo(m.name, k)} className={childCls}>
                      <span
                        className={
                          "w-1.5 h-1.5 rounded-full shrink-0 " +
                          (k.name.startsWith(INSTANCE_PREFIX) ? "bg-cobble-500" : "bg-moss-500")
                        }
                      />
                      {k.displayName}
                    </NavLink>
                  </SortableChild>
                ))}
              </SortableContext>
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

  const childrenOf = (top: string) => branches.find((b) => b.name === top)?.children ?? [];
  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over?.id;
    if (!over) return;
    // A collection dropped among the tools is a mis-drop, not an instruction:
    // the groups are a reading of what each row IS, and a drag cannot change
    // that.
    if (!dragStaysInGroup(groups, String(e.active.id), String(over), childrenOf)) return;
    const next = reorderNav(branches, String(e.active.id), String(over));
    if (next) writeNavOrder(activeSlug, next);
  };

  const homeRow = !appMode && (
    <NavLink to="/" end className={linkCls}>
      <span className="truncate">Home</span>
    </NavLink>
  );
  const sortable = (list: typeof tops) => (
    <SortableContext items={list.map((t) => t.name)} strategy={verticalListSortingStrategy}>
      {list.map((m) => (
        <SortableTop key={m.name} id={m.name}>
          {(handle) => renderTop(m, handle)}
        </SortableTop>
      ))}
    </SortableContext>
  );
  // The same quiet stem an instance nav-group uses, so the grown sidebar reads
  // as one vocabulary: a small label, the rows under it.
  const stemCls = "px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 select-none";

  return (
    <div className="flex flex-col h-full min-h-0">
      {head}
      {!head && controls && <div className="shrink-0 flex justify-end px-2 pt-1.5">{controls}</div>}
      <nav data-tour="nav" className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-0.5">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          {groups.grouped ? (
            <>
              <div data-nav-group="collections" className={stemCls}>
                Collections
              </div>
              {homeRow}
              {sortable(groups.collections)}
              <div data-nav-group="tools" className={stemCls + " pt-3"}>
                Tools
              </div>
              {sortable(groups.tools)}
            </>
          ) : (
            <>
              {homeRow}
              {sortable(tops)}
            </>
          )}
        </DndContext>
      </nav>
        {foot}
    </div>
  );
}

/** Whole-row drag (Notion-style) with an 8px activation distance so plain
 *  clicks still navigate. Persists through the SAME per-device nav order the
 *  top bar + Customize-navigation use (writeNavOrder → event → useNavModules
 *  re-reads), so the two nav modes never disagree. */
function SortableTop({
  id,
  children,
}: {
  id: string;
  /** Given the drag handle's props, so the caller can put them on the ROW that
   *  drags rather than on everything inside it. */
  children: (handle: Record<string, unknown>) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  // A drag that reorders nothing still ends in a click. See useDragClickGuard.
  useDragClickGuard(isDragging);

  return (
    <div
      ref={setNodeRef}
      // Every row here is an <a>, and a browser drags a link NATIVELY: the
      // moment the pointer moves, the page starts a link-drag and the sortable
      // never sees another pointer event. With the hold sensor that read as
      // "the drag starts, then never lands" - dnd-kit had activated on the
      // timer and lost the pointer to the native drag on the first move
      // (2026-09-08). Refusing dragstart keeps the pointer with the sortable.
      onDragStart={(e) => e.preventDefault()}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-60 cursor-grabbing" : undefined}
    >
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

/** One child row inside a group, draggable among its own siblings.
 *
 *  Children used to sit INSIDE the group's drag listeners, which is what a
 *  `{...listeners}` spread on a wrapper means: grabbing a child started a drag
 *  of the whole block, because the listener it reached first belonged to the
 *  parent. So a child could not be moved within its parent, and trying moved
 *  the parent instead (reported 2026-09-04). Each child now carries its own. */
function SortableChild({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  useDragClickGuard(isDragging);
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Same reason as SortableTop: the child is a link, and a link drags
      // natively unless told not to.
      onDragStart={(e) => e.preventDefault()}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-60 cursor-grabbing" : undefined}
    >
      {children}
    </div>
  );
}
