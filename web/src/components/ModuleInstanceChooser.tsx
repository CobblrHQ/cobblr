import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ModuleInstance } from "../lib/api";

/** An honest aggregate destination for an instanceability:multi module whose
 *  base list is empty. Instead of the tile diving into ONE instance (dropping
 *  the others), land on the base page and — with no base-table items to show —
 *  present every instance (3D Printers · 50, Laser Cutters · 7 …) as a card so
 *  the user picks. Matches what the dashboard tile counts + names, and keeps the
 *  instances first-class (drilling into printers vs lasers is one click). Generic
 *  across machines / assets / any multi-instance module. */
export function ModuleInstanceChooser({
  instances,
  icon: Icon,
  noun,
}: {
  instances: ModuleInstance[];
  icon: LucideIcon;
  noun: string;
}) {
  const sorted = [...instances].sort((a, b) => (b.item_count ?? 0) - (a.item_count ?? 0));
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted dark:text-slate-400">
        No unfiled {noun}s here - everything lives under a type below. Pick one to
        drill in.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sorted.map((i) => {
          const n = i.item_count ?? 0;
          return (
            <Link
              key={i.instance_name}
              to={`/${i.instance_name}`}
              className="group flex items-center gap-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3 hover:border-cobble-300 dark:hover:border-cobble-700 hover:bg-subtle dark:hover:bg-slate-800/40 transition"
            >
              <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-cobble-50 dark:bg-cobble-950/30 text-accent">
                <Icon size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-content dark:text-mortar-100">
                  {i.display_name}
                </div>
                <div className="text-[11px] font-mono text-faint dark:text-slate-500">
                  {n} {noun}
                  {n === 1 ? "" : "s"}
                </div>
              </div>
              <ChevronRight size={16} className="flex-none text-faint dark:text-slate-600 group-hover:text-accent transition" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
