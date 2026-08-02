// Where a whole scan session goes - asked as an OVERLAY.
//
// This used to be an inline strip appended to the session it belonged to. So
// tapping the header's location chip inserted a full-height list of every room
// and bin BELOW every card in that session: the answer opened far from the
// control that asked, and read as more page content instead of as a question
// (the author, 2026-07-30: "wtf the picker opens all the way down there, it needs to
// be a proper overlay").
//
// It lives in its own component so the inline version cannot come back by
// accident: there is no way to render the session's location picker without
// also rendering the Modal around it, and Modal portals to <body>, so neither
// the page's stacking context nor the header's backdrop-blur can trap it.

import { Modal } from "@cobblr/platform-web";
import { LocationChipPicker } from "./LocationChipPicker";

/** What the overlay is being opened FOR. `set` gives the session a location and
 *  stops there; `file` places and files in one go, because the button that
 *  opened it already promised to file. */
export type PlacementMode = "set" | "file";

/** The overlay's wording, as a pure function so the two modes cannot drift into
 *  saying the same thing (the earlier bug was a button that said "file" and
 *  then asked a question instead). */
export function placementCopy(
  mode: PlacementMode,
  count: number,
  category: string | null,
): { title: string; subtitle: string } {
  const title = mode === "set" ? `Where do these ${count} live?` : `Where do these ${count} go?`;
  const subtitle =
    mode === "set"
      ? category
        ? `Set the location for the whole session, then file as ${category}.`
        : "Set the location for the whole session."
      : category
      ? `Pick a location and all ${count} are filed as ${category}.`
      : `Pick a location and all ${count} are filed.`;
  return { title, subtitle };
}

interface Props {
  open: boolean;
  mode: PlacementMode;
  /** How many items the answer applies to. */
  count: number;
  /** The session's agreed category, shown so the person can see both halves of
   *  what filing needs before committing to either. */
  category: string | null;
  /** The location the session is already set to, so the picker opens on it. */
  currentLocationId: string | null;
  onPick: (locationId: string) => void;
  /** Only offered in `file` mode - a deliberate "I will place these later". */
  onFileWithoutLocation?: () => void;
  onClose: () => void;
}

export function SessionLocationModal({
  open,
  mode,
  count,
  category,
  currentLocationId,
  onPick,
  onFileWithoutLocation,
  onClose,
}: Props) {
  if (!open) return null;
  const { title, subtitle } = placementCopy(mode, count, category);
  return (
    <Modal open onClose={onClose} size="lg" title={title} subtitle={subtitle}>
      <LocationChipPicker
        value={currentLocationId}
        onChange={(v) => {
          if (!v) return;
          onPick(v);
        }}
      />
      <div className="mt-4 pt-3 border-t border-line/40 dark:border-slate-700/60 flex items-center gap-3">
        {mode === "file" && onFileWithoutLocation && (
          <button
            type="button"
            onClick={onFileWithoutLocation}
            className="text-[11px] text-faint hover:text-content dark:hover:text-mortar-100 underline decoration-dotted"
          >
            File without a location
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-faint hover:text-content dark:hover:text-mortar-100"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
