// What an old label or link says about a place that is gone (#8884). A
// label is on a box someone is holding: "location not found" left them with
// a bin that was merged into another and no word of where its things went.

export interface MergedInto {
  kind: string;
  id: string;
  name: string;
}

export interface PlaceGone {
  code: "place_deleted";
  message: string;
  details: { name: string; merged_into: MergedInto | null };
}

/** The answer for a place that was deleted, merged into another or not. */
export function placeGone(name: string, mergedInto: MergedInto | null | undefined): PlaceGone {
  const into = mergedInto ?? null;
  return {
    code: "place_deleted",
    message: into
      ? `${name} was merged into ${into.name}: everything kept in it is there now.`
      : `${name} was deleted. It can be brought back from Recently deleted.`,
    details: { name, merged_into: into },
  };
}
