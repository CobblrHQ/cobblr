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
import { useNavModules } from "./useNavModules";

export function ModuleNav() {
  const { activeSlug } = useActiveOrg();
  const { tops, childrenByParent: children } = useNavModules(activeSlug);
  const [pickerScope, setPickerScope] = useState<string | null>(null);

  return (
    <>
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          "px-2 py-1 rounded transition text-sm whitespace-nowrap shrink-0 " +
          (isActive
            ? "text-cobble-600 font-semibold"
            : "text-slate-500 dark:text-slate-400 hover:text-cobble-500")
        }
      >
        dashboard
      </NavLink>
      {tops.map((m) => {
        const kids = children.get(m.name) ?? [];
        if (kids.length === 0) {
          // Plain link, no children to nest.
          return <ModuleTopLink key={m.name} name={m.name} label={m.displayName} />;
        }
        return (
          <ModuleGroupChip
            key={m.name}
            parent={m}
            children={kids}
            onInstallMore={() => setPickerScope(m.name)}
          />
        );
      })}

      <ModulePickerModal
        open={pickerScope !== null}
        onClose={() => setPickerScope(null)}
        scopeToParent={pickerScope ?? undefined}
      />
    </>
  );
}

function ModuleTopLink({ name, label }: { name: string; label: string }) {
  return (
    <NavLink
      to={`/${name}`}
      className={({ isActive }) =>
        "px-2 py-1 rounded transition text-sm whitespace-nowrap shrink-0 " +
        (isActive
          ? "text-cobble-600 font-semibold"
          : "text-slate-500 dark:text-slate-400 hover:text-cobble-500")
      }
    >
      {label.toLowerCase()}
    </NavLink>
  );
}

interface OrgModule {
  name: string;
  displayName: string;
  dependencies: string[];
  enabled: boolean;
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
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      {/* The parent name links to the module's page. The chevron is
          a separate button that toggles the popover on click — for
          users who reach for the chevron instead of waiting for
          hover. Hovering anywhere on the row also opens it. */}
      <NavLink
        to={`/${parent.name}`}
        className={({ isActive }) =>
          "pl-2 pr-1 py-1 rounded-l transition text-sm whitespace-nowrap " +
          (isActive
            ? "text-cobble-600 font-semibold"
            : "text-slate-500 dark:text-slate-400 hover:text-cobble-500")
        }
      >
        {parent.displayName.toLowerCase()}
      </NavLink>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={`${parent.displayName} specialisations`}
        className="pl-0.5 pr-1.5 py-1 rounded-r text-slate-400 dark:text-slate-500 hover:text-cobble-500 transition"
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
          className="w-64 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg z-[60] overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700 text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
            {parent.displayName.toLowerCase()} specialisations
          </div>
          <ul>
            {kids.map((k) => (
              <li key={k.name}>
                <NavLink
                  to={`/${parent.name}?lens=${k.name}`}
                  onClick={() => setOpen(false)}
                  className="px-3 py-2 text-sm text-slate-700 dark:text-mortar-100 hover:bg-mortar-50 dark:hover:bg-slate-800 transition flex items-center gap-2"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
                  <span className="flex-1">{k.displayName}</span>
                  <span className="text-[10px] font-mono text-slate-400">lens</span>
                </NavLink>
              </li>
            ))}
            {kids.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-400 italic">
                No specialisations enabled yet.
              </li>
            )}
          </ul>
          <button
            onClick={() => {
              setOpen(false);
              onInstallMore();
            }}
            className="w-full text-left px-3 py-2 border-t border-slate-100 dark:border-slate-700 hover:bg-mortar-50 dark:hover:bg-slate-800 transition flex items-center gap-2 text-sm text-cobble-600 dark:text-cobble-300"
          >
            <Settings2 size={13} />
            Manage specialisations…
          </button>
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
        "px-2 py-1 rounded transition flex items-center gap-1 text-xs whitespace-nowrap shrink-0 " +
        (isActive
          ? "text-cobble-600 font-semibold"
          : "text-slate-500 dark:text-slate-400 hover:text-cobble-500")
      }
      title="Workspace configuration"
    >
      <Sliders size={13} />
      config
    </NavLink>
  );
}
