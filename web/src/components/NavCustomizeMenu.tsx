// Navbar customize popover — the user's own "enable flag + sort" for
// their nav, right in the header (not buried in settings). Lists every
// top-level entry with a show/hide toggle and up/down reorder. Both are
// per-device prefs (localStorage via nav-order.ts), so each member tunes
// their own nav without an org-wide edit. The org-admin equivalent
// (rename / icon / org-wide hide) still lives on /configuration/presentation.
//
// Portaled to document.body: the header uses `backdrop-blur`, which
// makes it a containing block for fixed/absolute descendants — a popover
// rendered inside it would mis-position. (Same trap the Modal primitive
// documents.)

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Eye, EyeOff, SlidersHorizontal } from "lucide-react";
import { api } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useNavModules } from "./useNavModules";
import {
  moveInOrder,
  readNavActionsHidden,
  toggleNavActionHidden,
  toggleNavHidden,
  writeNavOrder,
} from "../lib/nav-order";

export function NavCustomizeMenu() {
  const { activeSlug } = useActiveOrg();
  const { allTops, hiddenNames } = useNavModules(activeSlug);
  // Modules that contribute a right-cluster icon (the "quick actions").
  const modules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const quickActions = (modules.data?.items ?? []).filter(
    (m) => m.enabled && m.headerAction,
  );
  // Read fresh each render — re-render is driven by useNavModules'
  // subscription to the same cobblr:nav-order-changed bus event.
  const actionsHidden = new Set(readNavActionsHidden(activeSlug));
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (
        btnRef.current &&
        !btnRef.current.contains(t) &&
        !t.closest("[data-nav-customize-pop]")
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const names = allTops.map((t) => t.name);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Customize navigation — show/hide + reorder"
        aria-label="Customize navigation"
        className={
          "transition p-1.5 " +
          (open
            ? "text-cobble-600"
            : "text-slate-400 dark:text-slate-500 hover:text-cobble-600")
        }
        data-testid="nav-customize"
      >
        <SlidersHorizontal size={14} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            data-nav-customize-pop
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            className="z-50 w-64 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl p-2"
          >
            <div className="flex items-baseline justify-between px-2 py-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
                customize nav
              </span>
              <span className="text-[10px] text-slate-400">this device</span>
            </div>
            {allTops.length === 0 && (
              <div className="px-2 py-2 text-xs text-slate-400 italic">
                Nothing enabled yet.
              </div>
            )}
            <ul className="max-h-80 overflow-y-auto">
              {allTops.map((t, i) => {
                const hidden = hiddenNames.has(t.name);
                return (
                  <li
                    key={t.name}
                    className="flex items-center gap-1 px-2 py-1 rounded hover:bg-mortar-50 dark:hover:bg-slate-800/60"
                    data-entry={t.name}
                  >
                    <button
                      type="button"
                      onClick={() => toggleNavHidden(activeSlug, t.name)}
                      title={hidden ? "Show in nav" : "Hide from nav"}
                      className="shrink-0 p-0.5"
                      data-testid={`nav-toggle-${t.name}`}
                    >
                      {hidden ? (
                        <EyeOff size={13} className="text-slate-400" />
                      ) : (
                        <Eye size={13} className="text-cobble-500" />
                      )}
                    </button>
                    <span
                      className={
                        "flex-1 text-sm truncate " +
                        (hidden
                          ? "text-slate-400 line-through"
                          : "text-slate-700 dark:text-mortar-100")
                      }
                    >
                      {t.displayName.toLowerCase()}
                    </span>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() =>
                        writeNavOrder(activeSlug, moveInOrder(names, t.name, -1))
                      }
                      title="Move up"
                      className="shrink-0 p-0.5 text-slate-400 hover:text-cobble-600 disabled:opacity-25 disabled:hover:text-slate-400"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={i === allTops.length - 1}
                      onClick={() =>
                        writeNavOrder(activeSlug, moveInOrder(names, t.name, 1))
                      }
                      title="Move down"
                      className="shrink-0 p-0.5 text-slate-400 hover:text-cobble-600 disabled:opacity-25 disabled:hover:text-slate-400"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Right-cluster quick-action icons (module-contributed). The
                module OFFERS the icon; the user opts in/out here. */}
            {quickActions.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-cobble-500 border-t border-slate-100 dark:border-slate-800 mt-1">
                  quick actions (right)
                </div>
                <ul>
                  {quickActions.map((m) => {
                    const ha = m.headerAction!;
                    const hidden = actionsHidden.has(m.name);
                    const Icon = moduleIcon(ha.icon);
                    return (
                      <li
                        key={m.name}
                        className="flex items-center gap-2 px-2 py-1 rounded hover:bg-mortar-50 dark:hover:bg-slate-800/60"
                        data-action-entry={m.name}
                      >
                        <button
                          type="button"
                          onClick={() => toggleNavActionHidden(activeSlug, m.name)}
                          title={hidden ? "Show icon" : "Hide icon"}
                          className="shrink-0 p-0.5"
                          data-testid={`nav-action-toggle-${m.name}`}
                        >
                          {hidden ? (
                            <EyeOff size={13} className="text-slate-400" />
                          ) : (
                            <Eye size={13} className="text-cobble-500" />
                          )}
                        </button>
                        <Icon
                          size={13}
                          className={
                            hidden ? "text-slate-300" : "text-slate-500 dark:text-slate-400"
                          }
                        />
                        <span
                          className={
                            "flex-1 text-sm truncate " +
                            (hidden
                              ? "text-slate-400 line-through"
                              : "text-slate-700 dark:text-mortar-100")
                          }
                        >
                          {ha.label.toLowerCase()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
