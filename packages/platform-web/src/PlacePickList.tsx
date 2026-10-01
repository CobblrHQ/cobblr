// Choose where things go: search, the places used last, every place, and the
// things that hold things ("Inside something": a backpack, a toolbox). The
// list a popover shows; the caller says what happens once one is chosen.

import { useState } from "react";
import { Backpack, Clock, MapPin } from "lucide-react";
import { SearchInput } from "./SearchInput";

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

export function PlacePickList({
  slug,
  places,
  holders,
  onPick,
  exclude,
}: {
  slug: string;
  places: PlaceChoice[];
  holders: PlaceChoice[];
  onPick: (choice: PlaceChoice) => void;
  /** Ids not to offer (a thing cannot go inside itself). */
  exclude?: ReadonlySet<string>;
}) {
  const [q, setQ] = useState("");
  const offered = (list: PlaceChoice[]) => (exclude ? list.filter((c) => !exclude.has(c.id)) : list);
  // Read once when the list opens: picking one closes it.
  const [remembered] = useState(() => readRecentPlaces(slug));
  const all = [...offered(places), ...offered(holders)];
  const recent = remembered
    .map((r) => all.find((c) => c.id === r.id && (c.holderKind ?? null) === (r.holderKind ?? null)))
    .filter((c): c is PlaceChoice => !!c);
  const needle = q.trim().toLowerCase();
  const matches = (c: PlaceChoice) => !needle || c.name.toLowerCase().includes(needle) || (c.line ?? "").toLowerCase().includes(needle);
  const placeRows = offered(places).filter(matches);
  const holderRows = offered(holders).filter(matches);

  const row = (c: PlaceChoice, section: string) => {
    const Icon = section === "recent" ? Clock : c.holderKind ? Backpack : MapPin;
    return (
      <li key={`${section}:${c.holderKind ?? "place"}:${c.id}`}>
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
  };
  const heading = (text: string) => <li className="px-2 pt-2 pb-0.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">{text}</li>;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-line dark:border-slate-800 p-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search places…" aria-label="Search places" size="sm" />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1" data-testid="place-pick-list">
        {!needle && recent.length > 0 && (
          <>
            {heading("Recent")}
            {recent.map((c) => row(c, "recent"))}
          </>
        )}
        {placeRows.length > 0 && (
          <>
            {heading("Places")}
            {placeRows.map((c) => row(c, "place"))}
          </>
        )}
        {holderRows.length > 0 && (
          <>
            {heading("Inside something")}
            {holderRows.map((c) => row(c, "holder"))}
          </>
        )}
        {placeRows.length === 0 && holderRows.length === 0 && (
          <li className="px-2 py-3 text-sm text-muted dark:text-slate-400">{needle ? `No place matches "${q.trim()}".` : "No places yet. Add one on the Locations page."}</li>
        )}
      </ul>
    </div>
  );
}
