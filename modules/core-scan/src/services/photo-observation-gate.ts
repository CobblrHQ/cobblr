// Whether a photo may ever leave as an internal example for the shared network
// (business-models doc 25 step c, #3769). PREPARED, NOT WIRED: nothing calls
// this yet, and the network refuses observations until the updated terms ship
// and the owner says go after a legal check.
//
// Every condition must hold. The answer names the first one that does not, so
// the reason is visible wherever the gate is used.

import { withArticle } from "@cobblr/platform-contract/plural";

export type IdentifyKind = "item" | "barcode_only" | "receipt" | "document" | "person" | "scene" | "unidentifiable";

export type PhotoGate = { keep: true } | { keep: false; why: string };

/** The row key the mail door stamps (`arrived_by: "email"`): the picture came
 *  in an email, not from the person's camera or upload. */
export const ARRIVED_BY_KEY = "arrived_by";

/** Whether a scan row's picture arrived by email: the row's own stamp (the
 *  mail door's photo path) or its session's origin (a receipt emailed in, by
 *  the inbound address or a mail connection such as Gmail). */
export function arrivedByEmail(row: { suggested_metadata?: unknown }, batchOrigin?: string | null): boolean {
  if (batchOrigin === "email") return true;
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  return meta[ARRIVED_BY_KEY] === "email";
}

export function photoObservationGate(opts: {
  /** users.photo_terms_accepted_at for the person who filed it. */
  termsAcceptedAt: Date | string | null | undefined;
  /** users.photo_terms_declined_at: the person declined the terms, or turned
   *  the setting off since. A decline wins over any earlier acceptance. */
  termsDeclinedAt?: Date | string | null;
  /** The workspace is an anonymous trial (try.cobblr.xyz sandbox). */
  sandbox: boolean;
  /** The picture arrived by email (arrivedByEmail). */
  fromEmail: boolean;
  /** What the identify classified the photo as. */
  kind: IdentifyKind | string | null | undefined;
  /** Whether the identify saw a person anywhere in the frame. */
  personInFrame: boolean;
  /** Whether the person filed (confirmed) the item this photo shows. */
  filed: boolean;
}): PhotoGate {
  if (opts.sandbox) return { keep: false, why: "a trial workspace never keeps a photo" };
  if (opts.termsDeclinedAt) return { keep: false, why: "the account declined keeping photos" };
  if (!opts.termsAcceptedAt) return { keep: false, why: "the account has not accepted the terms that allow keeping photos" };
  if (opts.fromEmail) return { keep: false, why: "a picture that arrived by email is never kept" };
  if (!opts.filed) return { keep: false, why: "only a photo of an item the person filed is kept" };
  if (opts.kind !== "item") return { keep: false, why: `${withArticle(opts.kind ?? "unclassified")} photo is never kept; only items` };
  if (opts.personInFrame) return { keep: false, why: "a photo with a person in it is never kept" };
  return { keep: true };
}
