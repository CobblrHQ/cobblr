// A suggested picture's bytes have a lifetime (#8941).
//
// Since #7447 a suggestion holds its picture in the suggestion store until
// someone answers it, and it held the whole download, up to 10 MB, for as
// long as nobody did. Staging's nightly dumps grew from 123 MB to 1.3 GB
// overnight (2.19 GB of held pictures uncompressed), thirty dumps were kept,
// and the disk holding them filled.
//
// So what a suggestion holds is a preview, the size a card draws, and only
// for HELD_DAYS after it was kept. Use it fetches the full picture again from
// where it was found (the preview if that site no longer answers), No thanks
// and Search again drop it, and an unanswered one drops it when its days are
// up. The row keeps its address, so a card still shows the picture: looking
// at it fetches it again and holds the preview for another HELD_DAYS.

import sharp from "sharp";
import type { Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";
import type { FetchedImage } from "./entity-image.js";

type Db = Kysely<CoreScanDB>;
const T = "core_scan_record_photo_suggestions" as const;

/** How long an unanswered suggestion holds its picture. */
export const HELD_DAYS = 14;
/** The longest edge of a held preview: a card's picture, twice over. */
export const HELD_EDGE = 640;
/** A held picture larger than this is shrunk to a preview. Every preview
 *  {@link forHolding} makes is under it; a row from before #8941 is not. */
export const HELD_MAX_BYTES = 256 * 1024;
/** How many oversized rows one visit shrinks. */
const SHRINK_PER_VISIT = 25;

/** What a suggestion keeps of a picture it found: a JPEG preview no longer
 *  than HELD_EDGE on its longest side. A picture already that small is kept
 *  as it is. One that cannot be read as an image and is too big to keep
 *  whole is not held at all (null): its address is enough to fetch it. */
export async function forHolding(image: FetchedImage): Promise<FetchedImage | null> {
  try {
    const out = await sharp(Buffer.from(image.bytes), { failOn: "none", animated: false })
      .rotate()
      .resize({ width: HELD_EDGE, height: HELD_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    if (image.bytes.length <= HELD_MAX_BYTES && out.length >= image.bytes.length) return image;
    return { bytes: new Uint8Array(out), mimeType: "image/jpeg", filename: `${image.filename.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "picture"}.jpg` };
  } catch {
    return image.bytes.length <= HELD_MAX_BYTES ? image : null;
  }
}

/** The columns that hold a picture, set from a preview or cleared. */
export function heldColumns(image: FetchedImage | null, at = new Date()) {
  return image
    ? { held_bytes: Buffer.from(image.bytes), held_type: image.mimeType, held_name: image.filename, held_at: at }
    : { held_bytes: null, held_type: null, held_name: null, held_at: null };
}

/** One visit's keeping of the lifetime: drop every held picture past its
 *  days or on a row that is no longer waiting for an answer, then shrink a
 *  page of pictures held whole before #8941. Answers what it did, and
 *  whether more oversized rows wait. */
export async function keepHeldWithinLifetime(db: Db, now = new Date()): Promise<{ dropped: number; shrunk: number; savedBytes: number; more: boolean }> {
  const cutoff = new Date(now.getTime() - HELD_DAYS * 86_400_000);
  // updated_at is left alone: the queue reads it as "newest first", and a
  // dropped preview is not news.
  const stale = await db
    .updateTable(T)
    .set(heldColumns(null))
    .where("held_bytes", "is not", null)
    .where((eb) => eb.or([eb("status", "!=", "suggested"), eb(eb.fn.coalesce("held_at", "updated_at"), "<", cutoff)]))
    .executeTakeFirst();
  const dropped = Number(stale.numUpdatedRows ?? 0);
  // octet_length reads a stored value's length without fetching it.
  const big = await db
    .selectFrom(T)
    .select(["entity_kind", "entity_id", "held_bytes", "held_type", "held_name", "held_at", "updated_at"])
    .where("held_bytes", "is not", null)
    .where((eb) => eb(eb.fn("octet_length", ["held_bytes"]), ">", HELD_MAX_BYTES))
    .limit(SHRINK_PER_VISIT + 1)
    .execute();
  let shrunk = 0;
  let savedBytes = 0;
  for (const r of big.slice(0, SHRINK_PER_VISIT)) {
    const whole = { bytes: new Uint8Array(r.held_bytes!), mimeType: r.held_type || "image/jpeg", filename: r.held_name || "picture.jpg" };
    const preview = await forHolding(whole);
    // The days count from when the picture was found, not from this shrink.
    await db
      .updateTable(T)
      .set(heldColumns(preview, r.held_at ?? r.updated_at))
      .where("entity_kind", "=", r.entity_kind)
      .where("entity_id", "=", r.entity_id)
      .execute();
    shrunk++;
    savedBytes += whole.bytes.length - (preview?.bytes.length ?? 0);
  }
  return { dropped, shrunk, savedBytes, more: big.length > SHRINK_PER_VISIT };
}

/** The picture a suggestion shows: the preview it holds, or, once that was
 *  dropped, the picture fetched again from where it was found and held for
 *  another HELD_DAYS. Null when there is none to show: the suggestion was
 *  answered, or the site no longer gives the picture. */
export async function heldPicture(db: Db, kind: string, id: string, download: (url: string) => Promise<FetchedImage | null>, now = new Date()): Promise<FetchedImage | null> {
  const row = await db
    .selectFrom(T)
    .select(["status", "held_bytes", "held_type", "held_name", "source_url"])
    .where("entity_kind", "=", kind)
    .where("entity_id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  if (row.held_bytes) return { bytes: new Uint8Array(row.held_bytes), mimeType: row.held_type || "image/jpeg", filename: row.held_name || "picture.jpg" };
  if (row.status !== "suggested" || !row.source_url) return null;
  const got = await download(row.source_url).catch(() => null);
  const preview = got ? await forHolding(got) : null;
  if (!preview) return null;
  // Only a row still waiting, and still holding nothing: an answer given
  // meanwhile is never undone.
  await db
    .updateTable(T)
    .set(heldColumns(preview, now))
    .where("entity_kind", "=", kind)
    .where("entity_id", "=", id)
    .where("status", "=", "suggested")
    .where("held_bytes", "is", null)
    .execute();
  return preview;
}
