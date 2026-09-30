// "Move everything to…": empty one place into another, optionally with the
// places inside it, optionally then deleting it (merging the two). The server
// does the moving (move-everything.ts); this is the choice and the words.
import { useState } from "react";
import { Modal } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import { ApiError, api, type Location, type PlaceMove } from "../lib/api";
import { LocationTreePicker } from "./LocationTreePicker";

/** What the toast says once it is done. */
export function movedSentence(m: PlaceMove): string {
  const what = [m.things.length ? countOf(m.things.length, "thing") : null, m.places.length ? countOf(m.places.length, "place") : null].filter(Boolean);
  const moved = what.length ? `Moved ${what.join(" and ")} from ${m.from.name} into ${m.to.name}.` : `${m.from.name} had nothing in it to move.`;
  return m.deleted ? `${moved} ${m.from.name} is deleted.` : moved;
}

/** What the toast says once Undo has put it back. */
export function putBackSentence(m: PlaceMove, back: { things: number; places: number; leftWhereTheyAre: number }): string {
  const left = back.leftWhereTheyAre
    ? ` ${countOf(back.leftWhereTheyAre, "thing")} ${back.leftWhereTheyAre === 1 ? "was" : "were"} moved again since, so ${back.leftWhereTheyAre === 1 ? "it stays" : "they stay"} where ${back.leftWhereTheyAre === 1 ? "it is" : "they are"}.`
    : "";
  return `Put everything back in ${m.from.name}.${left}`;
}

export function MoveEverythingModal({
  slug,
  place,
  placesInside,
  onClose,
  onMoved,
}: {
  slug: string;
  place: Location;
  /** How many places sit directly inside it. */
  placesInside: number;
  onClose: () => void;
  onMoved: (move: PlaceMove) => void;
}) {
  const [to, setTo] = useState<string | null>(null);
  const [places, setPlaces] = useState(placesInside > 0);
  const [merge, setMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withPlaces = merge || places;

  const run = async () => {
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      onMoved(await api.moveEverything(slug, place.id, { to, places: withPlaces, then_delete: merge }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Move everything in ${place.name}`} size="sm">
      <div className="space-y-3" data-testid="move-everything">
        <div className="space-y-1">
          <span className="text-xs text-muted dark:text-slate-400">Into</span>
          {/* The places inside it cannot move into themselves. */}
          <LocationTreePicker value={to} onChange={setTo} excludeId={place.id} excludeSubtreeOf={withPlaces ? place.id : undefined} placeholder="Choose a place…" />
        </div>
        {placesInside > 0 && (
          <label className="flex items-start gap-2 text-sm text-content dark:text-slate-200">
            <input type="checkbox" className="mt-1" checked={withPlaces} disabled={merge} onChange={(e) => setPlaces(e.target.checked)} />
            <span>
              Also move the {placesInside === 1 ? "place" : countOf(placesInside, "place")} inside it, with what is in {placesInside === 1 ? "it" : "them"}
            </span>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm text-content dark:text-slate-200">
          <input type="checkbox" className="mt-1" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
          <span>
            Then delete {place.name}
            <span className="block text-xs text-muted dark:text-slate-400">For two places that are really one: everything ends up in the other.</span>
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">
            {error}
          </p>
        )}
        <p className="text-xs text-muted dark:text-slate-400">You can undo this straight after.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!to || busy}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm font-medium"
          >
            {merge ? `Move and delete ${place.name}` : "Move everything"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
