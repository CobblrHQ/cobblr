// Hierarchical module nav for the header. Reads the org's
// /modules endpoint and groups enabled modules by their first
// dependency:
//
//   machines    (base)
//     └ 3d-printers, laser-cutters, cnc-machines    (children)
//   projects    (base)
//     └ workshop-mods    (child)
//   inventory   (base)
//   labels      (base)
//   purchases   (base)
//   assets      (base)
//
// Parent rows are NavLinks. Children appear in a hover popover with
// a status dot + admin-only disable button + a footer that opens
// the ModulePicker modal for "manage specialisations…"
//
// Pillar-E modules with no api/UI route DON'T render as top-level
// links — they only appear in their parent's popover. Stops the
// nav from accumulating `/3d-printers` clutter that goes nowhere.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { ChevronDown, Settings2, Sliders } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ModulePickerModal } from "./ModulePickerModal";
import { NavCustomizeMenu } from "./NavCustomizeMenu";
import { useNavModules, HEADING_PREFIX } from "./useNavModules";

export function ModuleNav() {
  const { activeSlug } = useActiveOrg();
  const { tops, childrenByParent: children } = useNavModules(activeSlug);
  const [pickerScope, setPickerScope] = useState<string | null>(null);
  // Scan moved to the right cluster as a module-declared headerAction
  // (an icon-only quick-action) — see HeaderActions. It's no longer a
  // hardcoded left-nav text link.

  // ── Single-row overflow ─────────────────────────────────────────────
  // The nav must never wrap to a second line. We render every top link,
  // measure how many fit on one row, and fold the rest into a trailing
  // "more ▾" dropdown. Item widths are stable (label-driven), so we cache
  // each one the first time it's in the DOM and recompute on resize —
  // shrinking the visible set as the window narrows, growing it back as
  // it widens. Nothing past the fold is lost; it's in "more".
  const rowRef = useRef<HTMLDivElement>(null);
  const widthCache = useRef<Map<string, number>>(new Map());
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);
  const topsKey = tops.map((t) => t.name).join("|");

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const recompute = () => {
      // Cache the rendered width (+ the 2px gap) of every top in the DOM.
      el.querySelectorAll<HTMLElement>("[data-top]").forEach((n) => {
        widthCache.current.set(n.dataset.top!, n.getBoundingClientRect().width + 2);
      });
      // Reserve the fixed entries (dashboard + the customize gear).
      let reserved = 0;
      el.querySelectorAll<HTMLElement>("[data-navfixed]").forEach((n) => {
        reserved += n.getBoundingClientRect().width + 2;
      });
      const avail = el.clientWidth - reserved;
      const MORE_W = 64; // the "more ▾" chip, reserved only when it shows
      const fitWithin = (budget: number) => {
        let used = 0;
        let n = 0;
        for (const m of tops) {
          const w = widthCache.current.get(m.name) ?? 110;
          if (used + w > budget) break;
          used += w;
          n++;
        }
        return n;
      };
      let n = fitWithin(avail);
      if (n < tops.length) n = fitWithin(avail - MORE_W); // make room for "more"
      setVisibleCount(n);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
    // topsKey (not `tops`, a fresh array each render) keeps this stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topsKey]);

  const visible = tops.slice(0, visibleCount);
  const overflow = tops.slice(visibleCount);

  const renderTop = (m: (typeof tops)[number]) => {
    const kids = children.get(m.name) ?? [];
    return kids.length === 0 ? (
      <ModuleTopLink key={m.name} name={m.name} label={m.displayName} />
    ) : (
      <ModuleGroupChip
        key={m.name}
        parent={m}
        children={kids}
        onInstallMore={() => setPickerScope(m.name)}
      />
    );
  };

  return (
    <>
      <div
        ref={rowRef}
        className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden"
      >
        <NavLink
          to="/"
          end
          data-navfixed
          className={({ isActive }) =>
            "px-2 py-1 rounded transition text-sm whitespace-nowrap shrink-0 " +
            (isActive
              ? "text-accent font-semibold"
              : "text-muted dark:text-slate-400 hover:text-accent")
          }
        >
          dashboard
        </NavLink>
        {visible.map(renderTop)}
        {overflow.length > 0 && (
          <MoreMenu
            items={overflow.map((m) => ({ top: m, kids: children.get(m.name) ?? [] }))}
          />
        )}
        {/* Customize control trails the links — it acts on the nav, so it
            lives with the nav (not beside the config gear in the right
            cluster, where two slider icons read as duplicates). */}
        <span data-navfixed className="shrink-0 flex items-center">
          <NavCustomizeMenu />
        </span>
      </div>

      <ModulePickerModal
        open={pickerScope !== null}
        onClose={() => setPickerScope(null)}
        scopeToParent={pickerScope ?? undefined}
      />
    </>
  );
}

const INSTANCE_PREFIX = "__instance__";

function ModuleTopLink({ name, label }: { name: string; label: string }) {
  // Synthetic instance entries (useNavModules) route to the platform
  // per-instance page; real modules route to their own top path.
  const to = name.startsWith(INSTANCE_PREFIX)
    ? `/instances/${name.slice(INSTANCE_PREFIX.length)}`
    : `/${name}`;
  return (
    <NavLink
      to={to}
      data-top={name}
      className={({ isActive }) =>
        "px-2 py-1 rounded transition text-sm whitespace-nowrap shrink-0 " +
        (isActive
          ? "text-accent font-semibold"
          : "text-muted dark:text-slate-400 hover:text-accent")
      }
    >
      {label.toLowerCase()}
    </NavLink>
  );
}

/** Trailing "more ▾" dropdown holding the top links that didn't fit on
 *  the row. Each overflow top is a link (or a label, for a heading) with
 *  its lens/instance children nested beneath — so nothing is lost when
 *  the nav is wider than the window. Portaled to body (the header's
 *  backdrop-blur traps position:fixed descendants). */
function MoreMenu({
  items,
}: {
  items: { top: OrgModule; kids: { name: string; displayName: string }[] }[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  function scheduleClose() {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  }
  function openNow() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    function reposition() {
      const r = triggerRef.current!.getBoundingClientRect();
      // Right-align the 256px panel to the trigger so it never runs off
      // the right edge.
      setPos({ left: r.right - 256, top: r.bottom });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (
        !(triggerRef.current?.contains(t) ?? false) &&
        !(popoverRef.current?.contains(t) ?? false)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const childTo = (parentName: string, k: { name: string }) =>
    k.name.startsWith(INSTANCE_PREFIX)
      ? `/instances/${k.name.slice(INSTANCE_PREFIX.length)}`
      : parentName.startsWith(HEADING_PREFIX)
        ? `/${k.name}`
        : `/${parentName}?lens=${k.name}`;
  const topTo = (m: OrgModule) =>
    m.name.startsWith(HEADING_PREFIX)
      ? null
      : m.name.startsWith(INSTANCE_PREFIX)
        ? `/instances/${m.name.slice(INSTANCE_PREFIX.length)}`
        : `/${m.name}`;

  return (
    <div
      className="relative shrink-0 flex items-center"
      ref={triggerRef}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="More navigation links"
        className="px-1.5 py-1 rounded text-sm whitespace-nowrap text-muted dark:text-slate-400 hover:text-accent transition flex items-center gap-0.5"
      >
        more
        <ChevronDown
          size={12}
          className={open ? "rotate-180 transition-transform" : "transition-transform"}
        />
      </button>
      {open && pos && createPortal(
        <div
          ref={popoverRef}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
          style={{ position: "fixed", left: Math.max(8, pos.left), top: pos.top }}
          className="w-64 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-[60] max-h-[70vh] overflow-y-auto"
        >
          <ul className="py-1">
            {items.map(({ top, kids }) => {
              const to = topTo(top);
              return (
                <li key={top.name}>
                  {to ? (
                    <NavLink
                      to={to}
                      onClick={() => setOpen(false)}
                      className="block px-3 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
                    >
                      {top.displayName.toLowerCase()}
                    </NavLink>
                  ) : (
                    <div className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
                      {top.displayName.toLowerCase()}
                    </div>
                  )}
                  {kids.length > 0 && (
                    <ul className="pb-1">
                      {kids.map((k) => (
                        <li key={k.name}>
                          <NavLink
                            to={childTo(top.name, k)}
                            onClick={() => setOpen(false)}
                            className="flex items-center gap-2 pl-7 pr-3 py-1.5 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 transition"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
                            {k.displayName}
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface OrgModule {
  name: string;
  displayName: string;
  dependencies: string[];
  enabled: boolean;
  /** Workspace-customised heading for this module's specialisations /
   *  instances dropdown. Overrides the default "<module> specialisations".
   *  Set on /configuration/presentation. */
  groupLabel?: string | null;
}

function ModuleGroupChip({
  parent,
  children: kids,
  onInstallMore,
}: {
  parent: OrgModule;
  children: OrgModule[];
  onInstallMore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Debounced close — cursor crossing the 0px gap between trigger
  // and popover briefly hovers `document.body`. Without a grace
  // period the popover snaps shut before the user can click an
  // entry. 120ms is the hover-intent number; matches what
  // Linear/Slack feel like.
  const closeTimer = useRef<number | null>(null);
  // Viewport-absolute position for the portaled popover (in viewport
  // coords because we render via createPortal(document.body) to
  // escape ancestor clipping like the header's overflow-x-clip).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  function scheduleClose() {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  }
  function cancelClose() {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }
  function openNow() {
    cancelClose();
    setOpen(true);
  }

  // Recompute position whenever the popover opens or the window resizes.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    function reposition() {
      const r = triggerRef.current!.getBoundingClientRect();
      // top = r.bottom (no gap) — the popover sits flush against the
      // trigger so the cursor never crosses empty space.
      setPos({ left: r.left, top: r.bottom });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  // Click-outside closes (covers tap-to-dismiss + non-hover devices).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (
        !(triggerRef.current?.contains(t) ?? false) &&
        !(popoverRef.current?.contains(t) ?? false)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div
      className="relative shrink-0 flex items-center"
      ref={triggerRef}
      data-top={parent.name}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      {/* The parent name links to the module's page; the chevron toggles
          the popover. A user-defined HEADING has no page of its own — it's
          a pure label that just opens its dropdown. Hovering the row opens
          it either way. */}
      {parent.name.startsWith(HEADING_PREFIX) ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="pl-2 pr-1 py-1 rounded-l transition text-sm whitespace-nowrap text-muted dark:text-slate-400 hover:text-accent"
        >
          {parent.displayName.toLowerCase()}
        </button>
      ) : (
        <NavLink
          to={`/${parent.name}`}
          className={({ isActive }) =>
            "pl-2 pr-1 py-1 rounded-l transition text-sm whitespace-nowrap " +
            (isActive
              ? "text-accent font-semibold"
              : "text-muted dark:text-slate-400 hover:text-accent")
          }
        >
          {parent.displayName.toLowerCase()}
        </NavLink>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={parent.groupLabel || `${parent.displayName} specialisations`}
        className="pl-0.5 pr-1.5 py-1 rounded-r text-faint dark:text-slate-500 hover:text-accent transition"
      >
        <ChevronDown
          size={12}
          className={
            open ? "rotate-180 transition-transform" : "transition-transform"
          }
        />
      </button>
      {open && pos && createPortal(
        <div
          ref={popoverRef}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
          style={{ position: "fixed", left: pos.left, top: pos.top }}
          className="w-64 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg z-[60] overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-line dark:border-slate-700 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
            {parent.name.startsWith(HEADING_PREFIX)
              ? parent.displayName.toLowerCase()
              : (parent.groupLabel?.toLowerCase()
                ?? `${parent.displayName.toLowerCase()} specialisations`)}
          </div>
          <ul>
            {kids.map((k) => {
              // Three child kinds:
              //  - instance (#1): links to its own /instances/<name>.
              //  - module member under a HEADING (#2): links to /<module>.
              //  - lens child: applies a ?lens= filter to the parent module.
              const isInstance = k.name.startsWith(INSTANCE_PREFIX);
              const parentIsHeading = parent.name.startsWith(HEADING_PREFIX);
              const to = isInstance
                ? `/instances/${k.name.slice(INSTANCE_PREFIX.length)}`
                : parentIsHeading
                  ? `/${k.name}`
                  : `/${parent.name}?lens=${k.name}`;
              const badge = isInstance ? "instance" : parentIsHeading ? "" : "lens";
              return (
                <li key={k.name}>
                  <NavLink
                    to={to}
                    onClick={() => setOpen(false)}
                    className="px-3 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2"
                  >
                    <span
                      className={
                        "w-1.5 h-1.5 rounded-full shrink-0 " +
                        (isInstance ? "bg-cobble-500" : "bg-moss-500")
                      }
                    />
                    <span className="flex-1">{k.displayName}</span>
                    {badge && (
                      <span className="text-[10px] font-mono text-faint">
                        {badge}
                      </span>
                    )}
                  </NavLink>
                </li>
              );
            })}
            {kids.length === 0 && (
              <li className="px-3 py-2 text-xs text-faint italic">
                No specialisations enabled yet.
              </li>
            )}
          </ul>
          {/* The "manage specialisations" affordance is module-specific;
              headings are managed in the nav builder, not here. */}
          {!parent.name.startsWith(HEADING_PREFIX) && (
          <button
            onClick={() => {
              setOpen(false);
              onInstallMore();
            }}
            className="w-full text-left px-3 py-2 border-t border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-accent dark:text-cobble-300"
          >
            <Settings2 size={13} />
            Manage specialisations…
          </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** A single labeled link to the workspace configuration room.
 *  Replaces the earlier cryptic `⋯` overflow menu — that was
 *  hiding modules / bundles / wires / fields / activity / tokens
 *  behind an icon nobody found. They all live as tiles on
 *  /configuration now.
 *
 *  Distinct from a future /settings (user-level preferences like
 *  dark mode). Configuration changes how the workspace operates;
 *  settings change how the user personally sees it. */
export function ConfigurationLink() {
  return (
    <NavLink
      to="/configuration"
      className={({ isActive }) =>
        "rounded transition p-1.5 shrink-0 " +
        (isActive
          ? "text-accent"
          : "text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-100")
      }
      title="Workspace configuration"
    >
      <Sliders size={14} />
    </NavLink>
  );
}
