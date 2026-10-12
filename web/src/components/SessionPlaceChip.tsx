// A scan session's PLACE, stated in its header rather than discovered by
// pressing File: set the location, then file.
//
// This chip shares one line with the session's date and count, and those are
// what the line is for (#3996: "14 of 17 unplaced" left "21 items" cut and, at
// 320px, no count at all; #4029: at 640px, where the words came back, the date
// and count went). So below `lg` it is the pin plus at most a number: what is
// still missing, or what will be suggested. The full sentence is its title and
// its accessible name at every width, and tapping it opens the same picker.
// From `lg` up the row has room and it says it in words.
// e2e/session-headline-fits.test.mjs lays it out beside the real headline in
// every state below.

import { MapPin } from "lucide-react";

export interface SessionPlaceChipProps {
  /** How many items in the session take a location. */
  total: number;
  /** How many of those have none yet. */
  missing: number;
  /** How many of the missing have a suggested spot File all will use. */
  suggested: number;
  /** Where the missing ones are suggested to go, by name (distinct). */
  suggestedNames?: readonly string[];
  /** Why, when every unplaced item shares one suggested place. */
  suggestedWhy?: string | null;
  /** Set to different places. */
  mixed: boolean;
  /** The one place they are set to, as the user reads it; null when none is. */
  placeName: string | null;
  onClick: (e: React.MouseEvent) => void;
}

export function sessionPlaceTitle(p: Omit<SessionPlaceChipProps, "onClick">): string {
  if (p.mixed) return "These are set to different places - tap to give the whole session one location";
  if (p.placeName && p.missing === 0) return `All ${p.total} are set to ${p.placeName} - tap to move them somewhere else`;
  if (p.placeName) return `${p.total - p.missing} of ${p.total} are in ${p.placeName}; the other ${p.missing} have no location yet - tap to set it`;
  if (p.missing > 0 && p.suggested === p.missing) {
    const names = p.suggestedNames ?? [];
    if (names.length > 0) return `${names.length === 1 && p.suggestedWhy ? `${names[0]}, ${p.suggestedWhy}` : `Suggested: ${names.join(", ")}`}. File all will use ${names.length === 1 ? "it" : "them"} - tap to set one yourself`;
    return `${p.suggested} have a suggested location that File all will use - tap to set one yourself`;
  }
  return `None of these ${p.total} have a location yet - tap to set it`;
}

export function SessionPlaceChip(props: SessionPlaceChipProps) {
  const { total, missing, suggested, mixed, placeName, onClick } = props;
  const title = sessionPlaceTitle(props);
  const names = props.suggestedNames ?? [];
  const allSuggested = missing > 0 && suggested === missing;
  const settled = (placeName && missing === 0) || allSuggested;
  return (
    <button
      type="button"
      data-session-place
      onClick={onClick}
      title={title}
      aria-label={title}
      // The box is the finger's target (the session strip sizes it on a
      // phone, #5903); the pill is drawn on the span inside it.
      className="group inline-flex shrink-0 items-center justify-center"
    >
      <span className={`inline-flex items-center gap-1.5 max-lg:gap-1 rounded-full border px-2.5 max-lg:px-2 py-1 text-[11.5px] font-medium ${
        settled
          ? "border-line/70 dark:border-slate-700/70 text-content dark:text-mortar-100 group-hover:border-cobble-400"
          : "border-amber-400 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300 group-hover:border-amber-500"
      }`}>
      <MapPin size={12} className="shrink-0" />
      {mixed ? (
        <span className="max-lg:hidden">Mixed locations</span>
      ) : allSuggested ? (
        // Every unplaced item has a suggested spot, and File all will use
        // them. Amber "Location" over that read as "nothing has a home"
        // (2026-09-06); this says what will actually happen.
        // Never a bare count (#4582): one place is named, several say how many places.
        <span className={names.length === 1 ? "min-w-0 max-w-[10rem] truncate" : undefined}>
          {names.length === 1 ? names[0] : names.length > 1 ? `${names.length} places` : suggested}
          {/* Why, never a bare "suggested" (#4933): one place says its
              reason; several say each item has its own. */}
          <span className="max-lg:hidden"> · {names.length === 1 && props.suggestedWhy ? props.suggestedWhy : "each beside things like it"}</span>
        </span>
      ) : placeName && missing === 0 ? (
        <span className="max-lg:hidden">{placeName}</span>
      ) : placeName ? (
        // PARTIAL. Lead with what is missing, because that is the thing left
        // to do: naming the one place that IS set read as the whole session's
        // home (reported 2026-08-01). On a phone the count alone, beside an
        // amber pin: the date and the item count keep the line.
        <span>
          {missing}
          <span className="max-lg:hidden"> of {total} need a location</span>
        </span>
      ) : (
        // It's a button: say the action, not the absence. On a phone the pin
        // alone (its title says the rest): the word cost the identity beside
        // it its last characters (#2982).
        <span className="max-lg:hidden">Location</span>
      )}
    </span>
    </button>
  );
}
