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
import { NavLink, useLocation } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { writeNavOrder } from "../lib/nav-order";
import { ArrowLeft } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { isConfigurationPath } from "../lib/configuration-nav";
import { ConfigSidebarBody } from "./ConfigurationLayout";
import {
  useNavModules,
  HEADING_PREFIX,
  NAVGROUP_PREFIX,
  INSTANCE_PREFIX,
  stripNavStem,
} from "./useNavModules";

const linkCls = ({ isActive }: { isActive: boolean }) =>
  "block px-3 py-1.5 rounded text-sm transition truncate " +
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
  const { tops, childrenByParent: children, instanceGroups } = useNavModules(activeSlug);
  // HOOKS STAY ABOVE the config-fold early return — a hook below it renders
  // in one branch but not the other, and React throws "Rendered more hooks
  // than during the previous render" the moment you navigate between them.
  // Drag-to-reorder sensors: 8px activation so plain clicks still navigate.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

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

  const renderTop = (m: (typeof tops)[number]) => {
          // Instance nav-group: quiet stem label, members indented.
          if (m.name.startsWith(NAVGROUP_PREFIX)) {
            const g = instanceGroups.get(m.name);
            if (!g) return null;
            return (
              <div key={m.name}>
                <div className="px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 select-none">
                  {g.label}
                </div>
                {g.members.map((mem) => (
                  <NavLink key={mem.name} to={`/${mem.name.slice(INSTANCE_PREFIX.length)}`} className={childCls}>
                    <span className="w-1.5 h-1.5 rounded-full bg-cobble-500 shrink-0" />
                    {stripNavStem(mem.displayName, g.label)}
                  </NavLink>
                ))}
              </div>
            );
          }
          const kids = children.get(m.name) ?? [];
          // A user-defined heading has no page — it's a label over its members.
          if (m.name.startsWith(HEADING_PREFIX)) {
            return (
              <div key={m.name}>
                <div className="px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 select-none">
                  {m.displayName}
                </div>
                {kids.map((k) => (
                  <NavLink key={k.name} to={childTo(m.name, k)} className={childCls}>
                    <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
                    {k.displayName}
                  </NavLink>
                ))}
              </div>
            );
          }
          const to = m.name.startsWith(INSTANCE_PREFIX) ? `/${m.name.slice(INSTANCE_PREFIX.length)}` : `/${m.name}`;
          return (
            <div key={m.name}>
              <NavLink to={to} className={linkCls}>
                {m.displayName}
              </NavLink>
              {kids.map((k) => (
                <NavLink key={k.name} to={childTo(m.name, k)} className={childCls}>
                  <span
                    className={
                      "w-1.5 h-1.5 rounded-full shrink-0 " +
                      (k.name.startsWith(INSTANCE_PREFIX) ? "bg-cobble-500" : "bg-moss-500")
                    }
                  />
                  {k.displayName}
                </NavLink>
              ))}
            </div>
          );
  };
  const onDragEnd = (e: DragEndEvent) => {
    const over = e.over?.id;
    if (!over || e.active.id === over) return;
    const names = tops.map((t) => t.name);
    const from = names.indexOf(String(e.active.id));
    const to = names.indexOf(String(over));
    if (from < 0 || to < 0) return;
    writeNavOrder(activeSlug, arrayMove(names, from, to));
  };

  // Calendar slots in right after Locations/Lists (the quiet stock cluster) —
  // not dead-last, not up top with the headline modules.
  const calIdx = (() => {
    let idx = -1;
    tops.forEach((m, i) => {
      if (m.displayName === "Lists" || m.displayName === "Locations") idx = i;
    });
    return idx;
  })();
  const topsHead = calIdx >= 0 ? tops.slice(0, calIdx + 1) : tops;
  const topsTail = calIdx >= 0 ? tops.slice(calIdx + 1) : [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {head}
      {!head && controls && <div className="shrink-0 flex justify-end px-2 pt-1.5">{controls}</div>}
      <nav data-tour="nav" className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-0.5">
        {!appMode && (
          <NavLink to="/" end className={linkCls}>
            Dashboard
          </NavLink>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tops.map((t) => t.name)} strategy={verticalListSortingStrategy}>
            {topsHead.map((m) => (
              <SortableTop key={m.name} id={m.name}>
                {renderTop(m)}
              </SortableTop>
            ))}
            {/* Calendar rides with the quieter stock surfaces (Lists, Locations…)
                — not draggable itself yet (it joins the customize registry when
                this ships); it follows the Lists/Locations rows wherever they go. */}
            {!appMode && (
              <NavLink to="/calendar" className={linkCls}>
                Calendar
              </NavLink>
            )}
            {topsTail.map((m) => (
              <SortableTop key={m.name} id={m.name}>
                {renderTop(m)}
              </SortableTop>
            ))}
          </SortableContext>
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
function SortableTop({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-60 cursor-grabbing" : undefined}
    >
      {children}
    </div>
  );
}
