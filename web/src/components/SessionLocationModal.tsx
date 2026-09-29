// Where a whole scan session goes - asked as an OVERLAY.
//
// This used to be an inline strip appended to the session it belonged to. So
// tapping the header's location chip inserted a full-height list of every room
// and bin BELOW every card in that session: the answer opened far from the
// control that asked, and read as more page content instead of as a question
// (reported 2026-07-30: "wtf the picker opens all the way down there, it needs to
// be a proper overlay").
//
// It lives in its own component so the inline version cannot come back by
// accident: there is no way to render the session's location picker without
// also rendering the Modal around it, and Modal portals to <body>, so neither
// the page's stacking context nor the header's backdrop-blur can trap it.

import { Modal } from "@cobblr/platform-web";
import { LocationChipPicker } from "./LocationChipPicker";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { noteRecentLocation } from "../lib/recentLocations";
import type { PlaceSuggestion } from "../lib/sessionPlaceSuggestion";

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
  // One thing is "this one", never "these 1" (#3902).
  const which = count === 1 ? "does this one" : `do these ${count}`;
  const title = mode === "set" ? `Where ${which} live?` : `Where ${which} go?`;
  const it = count === 1 ? "it's" : "they're";
  const subtitle =
    mode === "set"
      ? category
        ? `Pick where ${count === 1 ? "this goes" : "these go"}, then ${it} filed as ${category}.`
        : `Pick where ${count === 1 ? "this goes" : "these go"} for the whole session.`
      : category
      ? `Pick a location and the ${count} ready ${count === 1 ? "item is" : "items are"} filed into it as ${category}. Anything still needing review stays here.`
      : `Pick a location and the ${count} ready ${count === 1 ? "item is" : "items are"} filed into it. Anything still needing review stays here.`;
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
  /** Where the session's items most likely go, and why (#3902). */
  suggestion?: PlaceSuggestion | null;
  onPick: (locationId: string) => void;
  /** Only offered in `file` mode - a deliberate "I will place these later". */
  onFileWithoutLocation?: () => void;
  /** `file` mode: open the plan-first filer for this session instead (what
   *  is added to things you have, what is new, what is left). On a phone
   *  this is the session's door to the plan; the row has no button for it. */
  onReviewPlan?: () => void;
  onClose: () => void;
}

export function SessionLocationModal({
  open,
  mode,
  count,
  category,
  currentLocationId,
  suggestion,
  onPick,
  onFileWithoutLocation,
  onReviewPlan,
  onClose,
}: Props) {
  const { activeSlug } = useActiveOrg();
  if (!open) return null;
  const { title, subtitle } = placementCopy(mode, count, category);
  return (
    // The explanation is a sentence in the body, not the Modal's subtitle: that
    // slot is small uppercase mono and read like a system message (#3902).
    <Modal open onClose={onClose} size="lg" title={title}>
      <p className="-mt-1 mb-3 text-sm text-muted dark:text-slate-400" data-testid="placement-explainer">
        {subtitle}
      </p>
      <LocationChipPicker
        value={currentLocationId}
        suggestion={suggestion ?? null}
        withShortcuts
        onChange={(v) => {
          if (!v) return;
          noteRecentLocation(activeSlug, v);
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
        {mode === "file" && onReviewPlan && (
          <button
            type="button"
            onClick={onReviewPlan}
            className="text-[11px] text-faint hover:text-content dark:hover:text-mortar-100 underline decoration-dotted"
            title="Shows a plan first: what gets added to things you already have, what is filed as new, what is left for you. Nothing is written until you confirm."
          >
            Review the plan first
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
