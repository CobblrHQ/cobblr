// Search in the full sidebar's foot (#4374): the icon that ends the
// Scan | Build row, so the foot reads Scan | Build | 🔍 instead of spending a
// full row on Search. It opens the same ⌘K palette every other door opens.
import { useState } from "react";
import { Search } from "lucide-react";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";
import { noteSearchUsed, searchHintShown } from "../lib/moreApps";

/** Search in the sidebar foot: the icon that ends the Scan | Build row, or a
 *  labelled row of its own when there is no action row to end. */
export function SearchButton({ alone }: { alone: boolean }) {
  const [hint, setHint] = useState(searchHintShown);
  const open = () => {
    noteSearchUsed();
    setHint(searchHintShown());
    window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
  };
  if (!alone) {
    return (
      <button
        type="button"
        onClick={open}
        title="Search (⌘K)"
        aria-label="Search (⌘K)"
        data-testid="foot-search"
        className="-my-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle dark:hover:bg-slate-800"
      >
        <Search size={16} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      title="Search (⌘K)"
      aria-label="Search (⌘K)"
      data-testid="foot-search"
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded text-[13px] text-muted dark:text-slate-400 hover:text-accent hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition"
    >
      <Search size={16} className="shrink-0" />
      <span className="truncate">
        Search{hint && <span className="text-faint dark:text-slate-500"> · apps, things, settings</span>}
      </span>
    </button>
  );
}
