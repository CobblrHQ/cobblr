// A place moved in its edit form offers Undo, as a merge or a delete does
// (#8882): put on the wrong shelf, a bin and everything in it stayed there,
// and the only way back was History's Restore, where nobody who just made a
// wrong move looks.
import { editOf, type Edit } from "@cobblr/platform-web";
import type { Location } from "./api";

export interface PlaceMoveUndo {
  sentence: string;
  /** The edit that puts the place back, sent against the place as saved. */
  back: Edit<Location>;
}

/** What to offer after a save, or null when the save did not move the place. */
export function placeMoveUndo(before: Location, saved: Location, names: ReadonlyMap<string, string>): PlaceMoveUndo | null {
  if ((before.parent_id ?? null) === (saved.parent_id ?? null)) return null;
  const into = saved.parent_id ? names.get(saved.parent_id) ?? "its new place" : "the top level";
  return {
    sentence: `Moved ${saved.name} into ${into}.`,
    back: editOf(saved, { parent_id: before.parent_id ?? null }),
  };
}
