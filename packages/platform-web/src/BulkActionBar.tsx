// Sticky bottom bar that appears whenever a list page has >0 rows
// selected. Renders selected count + a child slot for action
// buttons (delete, tag, archive, etc.) + a Clear-selection button.
//
// Shared in @cobblr/platform-web so AssetsPage / MachinesPage /
// PartsListPage / future list pages get the same affordance without
// each rebuilding it.

import type { ReactNode } from "react";
import { X } from "lucide-react";

interface Props {
  count: number;
  /** Action buttons to render between the count and the dismiss
   *  button. Each consumer page decides what actions make sense
   *  (delete / tag / move / etc.). */
  actions: ReactNode;
  onClear: () => void;
}

export function BulkActionBar({ count, actions, onClear }: Props) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg">
      <span className="text-sm font-medium text-content dark:text-mortar-100">
        {count} selected
      </span>
      <span className="text-faint dark:text-slate-600">·</span>
      <div className="flex items-center gap-2">{actions}</div>
      <button
        onClick={onClear}
        className="text-faint hover:text-content dark:hover:text-mortar-100 transition p-1"
        title="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  );
}
