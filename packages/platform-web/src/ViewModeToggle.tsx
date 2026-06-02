// List / tile view-mode toggle. Persists the selected mode per
// `storageKey` in localStorage so each entity-list page (parts,
// assets, machines) remembers what the user last chose.
//
// Designed to be a tiny header affordance — icon pair next to the
// search input, not a big segmented control.

import { useEffect, useState } from "react";
import { LayoutGrid, LayoutList } from "lucide-react";

export type ViewMode = "list" | "tiles";

const STORAGE_PREFIX = "cobblr.view-mode.";

export function useViewMode(
  storageKey: string,
  initial: ViewMode = "list",
): [ViewMode, (m: ViewMode) => void] {
  const key = STORAGE_PREFIX + storageKey;
  const [mode, setModeState] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return initial;
    const stored = window.localStorage.getItem(key);
    if (stored === "list" || stored === "tiles") return stored;
    return initial;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, mode);
  }, [key, mode]);
  return [mode, setModeState];
}

export function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded border border-line dark:border-slate-700 overflow-hidden shrink-0"
      role="group"
      aria-label="View mode"
    >
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-pressed={mode === "list"}
        title="List view"
        className={
          "p-1.5 transition " +
          (mode === "list"
            ? "bg-cobble-600 text-white"
            : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800")
        }
      >
        <LayoutList size={14} />
      </button>
      <button
        type="button"
        onClick={() => onChange("tiles")}
        aria-pressed={mode === "tiles"}
        title="Tile view"
        className={
          "p-1.5 transition " +
          (mode === "tiles"
            ? "bg-cobble-600 text-white"
            : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800")
        }
      >
        <LayoutGrid size={14} />
      </button>
    </div>
  );
}
