// Choose where things go: the platform's location chips (search, Recent, and
// an area's chevron opening its shelves and bins), then the things that hold
// things ("Inside something": a backpack, a toolbox). What a Move-to popover
// shows; the caller says what happens once one is chosen.
//
// It was its own flat list of places with a line under each, a third location
// picker beside the platform's two (#6438); lint:one-location-picker holds it
// to the platform's.

import { useState } from "react";
import { Backpack, Clock } from "lucide-react";
import { LocationChips } from "./context";

/** Somewhere a thing can be put. A place has no `holderKind`; a thing that
 *  holds things carries its kind ("inventory:part"). */
export interface PlaceChoice {
  id: string;
  name: string;
  /** Where it is, in words ("in Garage"), shown under the name. */
  line?: string | null;
  holderKind?: string;
}

const RECENT_KEY = (slug: string) => `cobblr:recent-places:${slug}`;
const RECENT_MAX = 3;

/** The places this person moved things to last, newest first. A convenience
 *  for this browser only, so a blocked storage reads as none. */
export function readRecentPlaces(slug: string): Array<{ id: string; holderKind?: string }> {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY(slug)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

export function noteRecentPlace(slug: string, choice: PlaceChoice): void {
  try {
    const next = [{ id: choice.id, ...(choice.holderKind ? { holderKind: choice.holderKind } : {}) }, ...readRecentPlaces(slug).filter((r) => r.id !== choice.id)];
    localStorage.setItem(RECENT_KEY(slug), JSON.stringify(next.slice(0, RECENT_MAX)));
  } catch {
    /* storage blocked: there is just no Recent next time */
  }
}

export function MoveToChoices({
  slug,
  places,
  holders,
  onPick,
  exclude,
}: {
  slug: string;
  /** Every place, so a chosen chip is handed back with its name and line. */
  places: PlaceChoice[];
  holders: PlaceChoice[];
  onPick: (choice: PlaceChoice) => void;
  /** Ids not to offer (a thing cannot go inside itself). */
  exclude?: ReadonlySet<string>;
}) {
  const offered = (list: PlaceChoice[]) => (exclude ? list.filter((c) => !exclude.has(c.id)) : list);
  // Read once when the list opens: picking one closes it.
  const [remembered] = useState(() => readRecentPlaces(slug));
  const holderRows = offered(holders);
  const recentHolders = new Set(remembered.filter((r) => r.holderKind).map((r) => r.id));
  const orderedHolders = [...holderRows.filter((h) => recentHolders.has(h.id)), ...holderRows.filter((h) => !recentHolders.has(h.id))];
  const pickPlace = (id: string | null) => {
    if (!id || exclude?.has(id)) return;
    onPick(places.find((p) => p.id === id) ?? { id, name: id });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="move-to-choices">
        <LocationChips value={null} onChange={pickPlace} withShortcuts />
        {orderedHolders.length > 0 && (
          <ul className="mt-2 border-t border-line dark:border-slate-800 pt-1">
            <li className="px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">Inside something</li>
            {orderedHolders.map((c) => {
              const Icon = recentHolders.has(c.id) ? Clock : Backpack;
              return (
                <li key={`${c.holderKind}:${c.id}`}>
                  <button
                    type="button"
                    data-place-choice={c.id}
                    onClick={() => onPick(c)}
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800"
                  >
                    <Icon size={14} className="mt-0.5 shrink-0 text-faint" />
                    <span className="min-w-0">
                      <span className="block truncate">{c.name}</span>
                      {c.line && <span className="block truncate text-xs text-muted dark:text-slate-400">{c.line}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
