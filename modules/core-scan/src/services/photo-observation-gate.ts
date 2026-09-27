// Whether a photo may ever leave as an internal example for the shared network
// (business-models doc 25 step c, #3769). PREPARED, NOT WIRED: nothing calls
// this yet, and the network refuses observations until the updated terms ship
// and the owner says go after a legal check.
//
// Every condition must hold. The answer names the first one that does not, so
// the reason is visible wherever the gate is used.

export type IdentifyKind = "item" | "barcode_only" | "receipt" | "document" | "person" | "scene" | "unidentifiable";

export type PhotoGate = { keep: true } | { keep: false; why: string };

export function photoObservationGate(opts: {
  /** users.photo_terms_accepted_at for the person who filed it. */
  termsAcceptedAt: Date | string | null | undefined;
  /** What the identify classified the photo as. */
  kind: IdentifyKind | string | null | undefined;
  /** Whether the identify saw a person anywhere in the frame. */
  personInFrame: boolean;
  /** Whether the person filed (confirmed) the item this photo shows. */
  filed: boolean;
}): PhotoGate {
  if (!opts.termsAcceptedAt) return { keep: false, why: "the account has not accepted the terms that allow keeping photos" };
  if (!opts.filed) return { keep: false, why: "only a photo of an item the person filed is kept" };
  if (opts.kind !== "item") return { keep: false, why: `a ${opts.kind ?? "unclassified"} photo is never kept; only items` };
  if (opts.personInFrame) return { keep: false, why: "a photo with a person in it is never kept" };
  return { keep: true };
}
