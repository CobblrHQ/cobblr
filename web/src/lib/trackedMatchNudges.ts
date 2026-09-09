// Two things the "Already tracked" banner should say when it is the right
// moment, pure so they are tests.
//
// A scan of green tea matched the green tea already on the shelf, and the
// banner offered "+1 to it". Correct, and it missed two facts it was holding:
// the scan had recognised the thing as TEA, and the tracked record lives in
// the base Inventory table, so the +1 quietly fed a record filed where nobody
// looks for tea; and the tracked record had no picture while the scan had just
// found a good one (2026-09-09). Both are one tap to fix, and the banner is
// the one place both facts are in view at once.

import { leadPhoto, type ScanPhotoItem } from "./scanPhoto";

export interface NudgeCandidate {
  module: string;
  instance: string | null;
  kind: string;
  label: string;
}

export interface NudgeMatch {
  kind: string;
  id: string;
  instance: string | null;
  image_path: string | null;
}

export interface NudgeMenuEntry {
  module: string;
  instance: string | null;
  kind: string;
  label: string;
}

export interface ListMismatch {
  module: string;
  /** The list the tracked record is in ("inventory" for the base table). */
  fromInstance: string;
  fromLabel: string;
  /** The list the scan says it belongs in. */
  toInstance: string;
  toLabel: string;
}

/** The scan says "Tea"; the record it matched is filed in Inventory. Only a
 *  NAMED list counts as the scan's opinion (the catch-all is where a scan
 *  goes when it has none), only within one module (a move across modules is
 *  not a move), and only when the two differ. */
export function listMismatch(
  top: NudgeCandidate | null | undefined,
  best: NudgeMatch | null | undefined,
  menu: readonly NudgeMenuEntry[],
): ListMismatch | null {
  if (!top || !best || !top.instance) return null;
  const tracked = menu.find((e) => e.kind === best.kind);
  if (!tracked || tracked.module !== top.module) return null;
  if ((tracked.instance ?? null) === top.instance) return null;
  return {
    module: tracked.module,
    // A module's default instance is named after the module (inventory's is
    // "inventory"); the mover's kindFor rule is what reads it back.
    fromInstance: tracked.instance ?? tracked.module,
    fromLabel: tracked.label,
    toInstance: top.instance,
    toLabel: top.label,
  };
}

export interface PictureOffer {
  file_id?: string;
  image_url?: string;
}

/** The tracked record has no picture and this scan has one to give it.
 *  WHICH picture is the one rule every scan surface answers with
 *  (lib/scanPhoto.ts): the catalog art it found (a stored file first, so no
 *  second download; else the external url), unless the cross-check found
 *  that art WRONG, in which case the person's own photo. Nothing when the
 *  record already has a picture: this is an offer, never an overwrite. */
export function pictureOffer(
  item: ScanPhotoItem & { catalog_image_file_id: string | null; catalog_image_url: string | null; image_file_id: string | null },
  best: NudgeMatch | null | undefined,
): PictureOffer | null {
  if (!best || best.image_path) return null;
  const lead = leadPhoto(item, {
    catalog: [item.catalog_image_file_id ? `file:${item.catalog_image_file_id}` : null, item.catalog_image_url ? `url:${item.catalog_image_url}` : null],
    yours: item.image_file_id ? `file:${item.image_file_id}` : null,
  });
  if (!lead.src) return null;
  return lead.src.startsWith("file:") ? { file_id: lead.src.slice(5) } : { image_url: lead.src.slice(4) };
}
