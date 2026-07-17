// Browse installable modules and enable them per-workspace. Lists
// every module registered with the platform, shows its enabled state
// for the active org, lets owner/admin enable/disable.
//
// Visual structure: each base module is its own bordered card, with
// its specialisations (modules that depend on it) nested as indented
// sub-cards inside. A child's first dependency is what anchors it to
// its parent — workshop-mods → projects (first dep), 3d-printers →
// machines, etc.
//
// Drag handles on the top-level cards reorder the workspace navbar
// (writes through `lib/nav-order`; the ModuleNav reads the same).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, GripVertical, Lock } from "lucide-react";
import { ApiError, api, type OrgModuleListItem } from "../lib/api";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { applyNavOrder, readNavOrder, writeNavOrder } from "../lib/nav-order";

// Launch-surface curation (docs/product/launch-simplification.md §4): the
// everyday tiles are the inventory-with-extra-hands set, the machine/floor
// modules present as one opt-in Workshop pack, and every other domain sits
// behind "More modules". Purely presentational — membership only, never
// order; names not installed simply don't render, and any module outside
// both lists lands in More automatically.
const LAUNCH_FEATURED = new Set(["inventory", "assets", "lists", "purchases", "labels"]);
const WORKSHOP_PACK = new Set(["digifab", "machines"]);

interface Props {
  /** Render in-flow (settings page mode) instead of as an overlay. */
  inline?: boolean;
  open: boolean;
  onClose: () => void;
  /** When set, the modal opens scoped to specialisations of this
   *  module (only shows modules whose `dependencies` include it).
   *  A "Show all modules" toggle expands the view. */
  scopeToParent?: string;
}

export function ModulePickerModal({ open, onClose, scopeToParent, inline }: Props) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [showAll, setShowAll] = useState(false);

  // Reset toggle when modal closes / parent changes.
  useEffect(() => {
    if (!open) setShowAll(false);
  }, [open, scopeToParent]);

  const list = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: open && !!activeSlug,
  });

  const items = list.data?.items ?? [];
  const enabledNames = new Set(items.filter((m) => m.enabled).map((m) => m.name));

  // Build the parent → children map. A "parent" here is a module
  // with no dependencies; everything else nests under its FIRST dep
  // (matching ModuleNav's grouping rule). If a child's first dep
  // isn't a base module in our list, it falls through as orphan.
  const { parents, kidsByParent, orphans } = useMemo(() => {
    const parents = items.filter((m) => m.dependencies.length === 0);
    const parentNames = new Set(parents.map((p) => p.name));
    const kidsByParent = new Map<string, OrgModuleListItem[]>();
    const orphans: OrgModuleListItem[] = [];
    for (const m of items) {
      if (m.dependencies.length === 0) continue;
      const firstDep = m.dependencies[0];
      if (firstDep && parentNames.has(firstDep)) {
        const arr = kidsByParent.get(firstDep) ?? [];
        arr.push(m);
        kidsByParent.set(firstDep, arr);
      } else {
        orphans.push(m);
      }
    }
    return { parents, kidsByParent, orphans };
  }, [items]);

  // Apply saved nav order to top-level parents (drag-to-reorder).
  const [navOrder, setNavOrder] = useState<string[]>(() => readNavOrder(activeSlug));
  useEffect(() => {
    if (open) setNavOrder(readNavOrder(activeSlug));
  }, [open, activeSlug]);
  const orderedParents = useMemo(
    () => applyNavOrder(parents, navOrder),
    [parents, navOrder],
  );

  // Scope filter: in scoped mode, render only the requested parent
  // with its kids; "show all" reverts to the full hierarchy.
  const visibleParents = scopeToParent && !showAll
    ? orderedParents.filter((p) => p.name === scopeToParent)
    : orderedParents;
  const visibleOrphans = scopeToParent && !showAll ? [] : orphans;

  // Split top-level "user-facing" modules from platform infrastructure
  // (the `core-*` set). Activity log, files, queue, etc. are real
  // module rows but they're plumbing — not a per-workspace product
  // choice the way Assets / BrickLink / Inventory are. They get a
  // compact one-line treatment at the bottom of the modal instead of
  // full-height tiles.
  const isPlatformCore = (m: OrgModuleListItem) => m.name.startsWith("core-");
  const userParents = visibleParents.filter((m) => !isPlatformCore(m));
  const corePlatform = visibleParents.filter(isPlatformCore);

  // Scoped mode already narrows to one parent — the launch split only
  // applies to the full browse view.
  const skipSplit = !!scopeToParent && !showAll;
  const featured = skipSplit
    ? userParents
    : userParents.filter((m) => LAUNCH_FEATURED.has(m.name));
  const workshop = skipSplit ? [] : userParents.filter((m) => WORKSHOP_PACK.has(m.name));
  const more = skipSplit
    ? []
    : userParents.filter((m) => !LAUNCH_FEATURED.has(m.name) && !WORKSHOP_PACK.has(m.name));

  const enable = useMutation({
    mutationFn: (name: string) => api.enableModule(activeSlug, name),
    onSuccess: (_r, name) => {
      toast.success(`Enabled ${name}.`);
      void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["platform-field-defs"] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't enable.");
    },
  });
  const disable = useMutation({
    mutationFn: (name: string) => api.disableModule(activeSlug, name),
    onSuccess: (_r, name) => {
      toast.success(`Disabled ${name}.`);
      void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["platform-field-defs"] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't disable.");
    },
  });

  async function handleDisable(m: OrgModuleListItem) {
    const ok = await confirm({
      title: `Disable ${m.displayName}?`,
      message:
        m.dependencies.length === 0
          ? `Module data stays in the tenant DB (re-enabling restores access). Any specialisation that depends on this module must be disabled first.`
          : `Removes this module's contributed fields and wires from this workspace. Your entity data is unaffected.`,
      confirmLabel: "Disable",
      destructive: true,
    });
    if (ok) disable.mutate(m.name);
  }

  function reorderTo(name: string, beforeName: string | null) {
    // Compute new order: pull `name` out, then insert before `beforeName`
    // (or append if null). Modules not yet in the saved order are
    // anchored by their current visible position.
    const currentNames = orderedParents.map((p) => p.name);
    const without = currentNames.filter((n) => n !== name);
    let insertAt = beforeName ? without.indexOf(beforeName) : without.length;
    if (insertAt < 0) insertAt = without.length;
    without.splice(insertAt, 0, name);
    setNavOrder(without);
    writeNavOrder(activeSlug, without);
  }

  const title = scopeToParent
    ? showAll
      ? "all modules"
      : `${scopeToParent} specialisations`
    : "modules";
  const subtitle = scopeToParent
    ? showAll
      ? `every module registered with cobblr`
      : `modules that extend ${scopeToParent}`
    : "enable, disable, and reorder per-workspace";

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} size="lg" inline={inline}>
      <div className="space-y-3">
        {scopeToParent && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted dark:text-slate-400">
              {showAll
                ? "Showing every module."
                : `Showing modules that depend on ${scopeToParent}.`}
            </span>
            <button
              onClick={() => setShowAll((s) => !s)}
              className="font-mono uppercase tracking-widest text-[10px] text-accent hover:text-accent transition"
            >
              {showAll ? `back to ${scopeToParent}` : "show all modules"}
            </button>
          </div>
        )}

        <ul className="space-y-3">
          {featured.map((p) => (
            <ParentCard
              key={p.name}
              parent={p}
              kids={kidsByParent.get(p.name) ?? []}
              enabledNames={enabledNames}
              onEnable={(name) => enable.mutate(name)}
              onDisable={handleDisable}
              busy={enable.isPending || disable.isPending}
              draggable={!scopeToParent || showAll}
              onDropBefore={(name) => reorderTo(name, p.name)}
              onDropAtEnd={(name) => reorderTo(name, null)}
              isLast={p === featured[featured.length - 1]}
            />
          ))}
          {visibleOrphans.map((m) => (
            <li key={m.name}>
              <Row
                m={m}
                enabledNames={enabledNames}
                onEnable={() => enable.mutate(m.name)}
                onDisable={() => handleDisable(m)}
                busy={enable.isPending || disable.isPending}
              />
              <div className="text-[10px] font-mono text-ember-500 mt-1 pl-3">
                orphan — its first dependency ({m.dependencies[0]}) isn't a known base module
              </div>
            </li>
          ))}
          {userParents.length === 0 && visibleOrphans.length === 0 && corePlatform.length === 0 && (
            <li className="text-xs text-faint italic text-center py-6">
              No modules match this filter.
            </li>
          )}
        </ul>

        {workshop.length > 0 && (
          <details className="mt-4 pt-3 border-t border-line dark:border-slate-700 group">
            <summary className="cursor-pointer list-none flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-400 transition">
              <span>
                {"// workshop pack ("}
                {workshop.length}
                {workshop.some((m) => m.enabled)
                  ? ` · ${workshop.filter((m) => m.enabled).length} on`
                  : ""}
                {")"}
              </span>
              <span className="text-faint dark:text-slate-600 group-open:rotate-90 transition-transform">▸</span>
            </summary>
            <div className="text-[11px] text-faint dark:text-slate-500 mt-2 mb-2">
              Run machines and a fabrication floor: a machine registry plus the
              Print Manager that sends files to your machines' own managers and
              tracks the jobs.
            </div>
            <ul className="space-y-3">
              {workshop.map((p) => (
                <ParentCard
                  key={p.name}
                  parent={p}
                  kids={kidsByParent.get(p.name) ?? []}
                  enabledNames={enabledNames}
                  onEnable={(name) => enable.mutate(name)}
                  onDisable={handleDisable}
                  busy={enable.isPending || disable.isPending}
                  draggable
                  onDropBefore={(name) => reorderTo(name, p.name)}
                  onDropAtEnd={(name) => reorderTo(name, null)}
                  isLast={p === workshop[workshop.length - 1]}
                />
              ))}
            </ul>
          </details>
        )}

        {more.length > 0 && (
          <details className="mt-4 pt-3 border-t border-line dark:border-slate-700 group">
            <summary className="cursor-pointer list-none flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-400 transition">
              <span>
                {"// more modules ("}
                {more.length}
                {more.some((m) => m.enabled)
                  ? ` · ${more.filter((m) => m.enabled).length} on`
                  : ""}
                {")"}
              </span>
              <span className="text-faint dark:text-slate-600 group-open:rotate-90 transition-transform">▸</span>
            </summary>
            <ul className="space-y-3 mt-2">
              {more.map((p) => (
                <ParentCard
                  key={p.name}
                  parent={p}
                  kids={kidsByParent.get(p.name) ?? []}
                  enabledNames={enabledNames}
                  onEnable={(name) => enable.mutate(name)}
                  onDisable={handleDisable}
                  busy={enable.isPending || disable.isPending}
                  draggable
                  onDropBefore={(name) => reorderTo(name, p.name)}
                  onDropAtEnd={(name) => reorderTo(name, null)}
                  isLast={p === more[more.length - 1]}
                />
              ))}
            </ul>
          </details>
        )}

        {corePlatform.length > 0 && (
          <details className="mt-5 pt-3 border-t border-line dark:border-slate-700 group">
            <summary className="cursor-pointer list-none flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-accent dark:hover:text-cobble-400 transition">
              <span>// platform infrastructure ({corePlatform.length})</span>
              <span className="text-faint dark:text-slate-600 group-open:rotate-90 transition-transform">▸</span>
            </summary>
            <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-2 mb-2 italic">
              Foundational modules. Modules built on top of cobblr assume
              these are on. Disabling something here will likely break
              every user-facing module in the workspace — flip with care.
            </div>
            <ul className="space-y-1">
              {corePlatform.map((m) => (
                <li key={m.name}>
                  <CoreRow
                    m={m}
                    enabledNames={enabledNames}
                    onEnable={() => enable.mutate(m.name)}
                    onDisable={() => handleDisable(m)}
                    busy={enable.isPending || disable.isPending}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="pt-3 border-t border-line dark:border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ParentCard({
  parent,
  kids,
  enabledNames,
  onEnable,
  onDisable,
  busy,
  draggable,
  onDropBefore,
  onDropAtEnd,
  isLast,
}: {
  parent: OrgModuleListItem;
  kids: OrgModuleListItem[];
  enabledNames: Set<string>;
  onEnable: (name: string) => void;
  onDisable: (m: OrgModuleListItem) => void;
  busy: boolean;
  draggable: boolean;
  onDropBefore: (name: string) => void;
  onDropAtEnd: (name: string) => void;
  isLast: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData("text/cobblr-module", parent.name);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!draggable) return;
        const name = e.dataTransfer.types.includes("text/cobblr-module");
        if (!name) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (!draggable) return;
        const moved = e.dataTransfer.getData("text/cobblr-module");
        if (moved && moved !== parent.name) {
          e.preventDefault();
          onDropBefore(moved);
        }
      }}
      className={
        "rounded-lg border bg-surface dark:bg-slate-900 transition " +
        (dragOver
          ? "border-accent ring-2 ring-accent dark:ring-cobble-900"
          : "border-line dark:border-slate-700")
      }
    >
      <Row
        m={parent}
        enabledNames={enabledNames}
        onEnable={() => onEnable(parent.name)}
        onDisable={() => onDisable(parent)}
        busy={busy}
        dragHandle={draggable}
        framed={false}
      />
      {kids.length > 0 && (
        <div className="pl-9 pr-3 pb-3 space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            specialisations
          </div>
          {kids.map((k) => (
            <Row
              key={k.name}
              m={k}
              enabledNames={enabledNames}
              onEnable={() => onEnable(k.name)}
              onDisable={() => onDisable(k)}
              busy={busy}
              compact
            />
          ))}
        </div>
      )}
      {/* When dropping past the last card, anchor the drop target there. */}
      {isLast && draggable && (
        <div
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("text/cobblr-module")) e.preventDefault();
          }}
          onDrop={(e) => {
            const moved = e.dataTransfer.getData("text/cobblr-module");
            if (moved) {
              e.preventDefault();
              onDropAtEnd(moved);
            }
          }}
          className="h-2"
        />
      )}
    </li>
  );
}

function Row({
  m,
  enabledNames,
  onEnable,
  onDisable,
  busy,
  dragHandle = false,
  compact = false,
  framed = true,
}: {
  m: OrgModuleListItem;
  enabledNames: Set<string>;
  onEnable: () => void;
  onDisable: () => void;
  busy: boolean;
  dragHandle?: boolean;
  compact?: boolean;
  framed?: boolean;
}) {
  const missingDeps = m.dependencies.filter((d) => !enabledNames.has(d));
  const blocked = missingDeps.length > 0;
  return (
    <div
      className={
        (compact
          ? "rounded-md border border-line dark:border-slate-700 bg-mortar-25 dark:bg-slate-800/40 p-2.5"
          : "p-3") +
        (framed && !compact ? " rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900" : "") +
        " flex items-start gap-2"
      }
    >
      {dragHandle ? (
        <button
          aria-label="Reorder"
          className="mt-0.5 shrink-0 text-faint hover:text-accent dark:text-slate-600 dark:hover:text-cobble-400 cursor-grab active:cursor-grabbing transition"
          onMouseDown={(e) => e.stopPropagation()}
          title="Drag to reorder in navbar"
        >
          <GripVertical size={14} />
        </button>
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <div className="mt-0.5 shrink-0">
        {m.enabled ? (
          <CheckCircle2 size={16} className="text-moss-600" />
        ) : blocked ? (
          <Lock size={16} className="text-faint" />
        ) : (
          <Circle size={16} className="text-faint" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={(compact ? "text-sm" : "text-sm") + " font-medium text-content dark:text-mortar-100"}>
            {m.displayName}
          </span>
          <span className="text-[10px] font-mono text-faint">v{m.version}</span>
          {m.dependencies.length > 0 && (
            <span className="text-[10px] font-mono text-faint dark:text-slate-500">
              · needs {m.dependencies.join(", ")}
            </span>
          )}
        </div>
        <div className={(compact ? "text-xs" : "text-xs") + " text-content dark:text-mortar-200 mt-0.5"}>
          {m.description}
        </div>
        {(m.contributes.fieldDefs > 0 || m.contributes.wires > 0) && (
          <div className="text-[10px] font-mono text-accent mt-1">
            contributes: {m.contributes.fieldDefs} field-def{m.contributes.fieldDefs === 1 ? "" : "s"}
            {m.contributes.wires > 0 && `, ${m.contributes.wires} wire${m.contributes.wires === 1 ? "" : "s"}`}
          </div>
        )}
        {blocked && (
          <div className="text-[10px] font-mono text-ember-500 mt-1">
            blocked — enable {missingDeps.join(", ")} first
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {m.enabled ? (
          <button
            onClick={onDisable}
            disabled={busy}
            className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition px-2 py-1"
          >
            disable
          </button>
        ) : (
          <button
            onClick={onEnable}
            disabled={busy || blocked}
            className="text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-line dark:border-slate-700 text-accent hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            enable
          </button>
        )}
      </div>
    </div>
  );
}

// One-line rendering for platform-infrastructure modules (the
// core-* set). Name + version + one-line description + enable
// toggle. No drag handle (foundational modules don't appear in the
// nav, so reordering them is meaningless). No "specialisations"
// nest. Description gets truncated.
function CoreRow({
  m,
  enabledNames,
  onEnable,
  onDisable,
  busy,
}: {
  m: OrgModuleListItem;
  enabledNames: Set<string>;
  onEnable: () => void;
  onDisable: () => void;
  busy: boolean;
}) {
  const missingDeps = m.dependencies.filter((d) => !enabledNames.has(d));
  const blocked = missingDeps.length > 0;
  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-subtle dark:hover:bg-slate-800/40 transition">
      <span className="shrink-0">
        {m.enabled ? (
          <CheckCircle2 size={12} className="text-moss-600" />
        ) : blocked ? (
          <Lock size={12} className="text-faint" />
        ) : (
          <Circle size={12} className="text-faint" />
        )}
      </span>
      <span className="text-xs font-medium text-content dark:text-mortar-200 shrink-0">
        {m.displayName}
      </span>
      <span className="text-[10px] font-mono text-faint shrink-0">v{m.version}</span>
      <span
        className="text-[11px] text-faint dark:text-slate-500 truncate flex-1"
        title={m.description}
      >
        {m.description}
      </span>
      {m.enabled ? (
        <button
          onClick={onDisable}
          disabled={busy}
          className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition px-2 shrink-0"
        >
          disable
        </button>
      ) : (
        <button
          onClick={onEnable}
          disabled={busy || blocked}
          className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border border-line dark:border-slate-700 text-accent hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          enable
        </button>
      )}
    </div>
  );
}
