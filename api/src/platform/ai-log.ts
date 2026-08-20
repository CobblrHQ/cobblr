// What the AI activity log stores, and what it must not.
//
// Pure + dependency-free on purpose: it lives apart from ai.ts so it can be
// tested without a database, and so the two rules it encodes are readable on
// their own.
//
//   1. Keep the PROSE. A system prompt is the thing you open the log to read.
//     The old rule clamped any string over 4000 characters down to 200, so a
//     real prompt became "You sort a scanned physical item into…[clamped]".
//     Length is not the question; "is this encoded bytes" is.
//
//   2. Keep a LOOK at the image. Vision calls stored "[image]", so you could
//      read a prompt asking about a photo and never see the photo. Storing the
//      original is not an option (megabytes per row), so we store a ~192px
//      thumbnail and leave the original out of the database.

/** Longest a stored thumbnail data URI may be. ~192px JPEG lands well under
 *  this; the limit is what keeps a log row bounded. */
export const THUMB_MAX_CHARS = 20_000;
/** Thumbnail at most this many images per call. A grid of tiles arrives as one
 *  image; a handful of separate photos should not each cost a row. */
export const THUMB_MAX_IMAGES = 3;

/** Replace image payloads with a SMALL thumbnail so the activity log can show
 *  what was sent.
 *
 *  The log used to drop images entirely ("[image]"), which is why a vision call
 *  was unreviewable: you could read the prompt asking about a photo and never
 *  see the photo. Storing the original is not an option — a phone picture is
 *  megabytes of base64 per row — so this downscales to ~192px JPEG, a few KB,
 *  and keeps the original out of the database.
 *
 *  Best-effort by design: anything that fails to decode is left for fullText to
 *  redact. Logging must never break the call it is describing. */
export async function thumbnailImages<T>(obj: T): Promise<T> {
  if (!obj || typeof obj !== "object") return obj;
  let made = 0;
  const shrink = async (b64: string): Promise<string | null> => {
    if (made >= THUMB_MAX_IMAGES) return null;
    try {
      const raw = b64.startsWith("data:") ? (b64.split(",")[1] ?? "") : b64;
      const buf = Buffer.from(raw, "base64");
      if (buf.length < 64) return null;
      const { default: sharp } = await import("sharp");
      const out = await sharp(buf)
        .rotate()
        .resize(192, 192, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
      const uri = `data:image/jpeg;base64,${out.toString("base64")}`;
      if (uri.length > THUMB_MAX_CHARS) return null;
      made++;
      return uri;
    } catch {
      return null; // unreadable / not an image → fullText redacts it
    }
  };

  const walk = async (v: unknown, key?: string): Promise<unknown> => {
    if (Array.isArray(v)) return Promise.all(v.map((x) => walk(x, key)));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = await walk(val, k);
      }
      return out;
    }
    if (typeof v === "string" && (key === "image_b64" || key === "images" || key === "image")) {
      return (await shrink(v)) ?? v;
    }
    return v;
  };

  return (await walk(obj)) as T;
}

/** Does this string look like encoded BYTES rather than something a person
 *  wrote? Long, unbroken, and drawn from the base64/hex alphabet.
 *
 *  The old rule was "longer than 4000 characters", which is a different
 *  question: a system prompt sails past 4000 and was being cut to 200, so the
 *  log read "You sort a scanned physical item into…[clamped]" and hid the
 *  actual instructions — the one thing you open the log to read. */
export function looksLikeBlob(s: string): boolean {
  if (s.length < 2_000) return false;
  const head = s.slice(0, 512);
  if (/\s/.test(head)) return false; // prose has spaces; base64 does not
  return /^[A-Za-z0-9+/=_-]+$/.test(head);
}

/** Shorten one long string from the MIDDLE, keeping both ends.
 *
 *  A system prompt's identity is at the top ("You are Cobb…") and the thing
 *  that changed is usually near the bottom. Cutting the tail keeps the least
 *  useful half of both. */
function elide(s: string, keep: number): string {
  if (s.length <= keep) return s;
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  const cut = s.length - keep;
  return `${s.slice(0, head)}\n\n…[${cut.toLocaleString()} characters elided]…\n\n${s.slice(s.length - tail)}`;
}

// Full text for the activity log. Blobs get clamped, prose is kept whole where
// it fits, and the payload is capped — so a vision call cannot balloon the log
// while the prompt you actually wanted to read survives.
//
// The cap is generous because an entry may now carry a small image thumbnail
// (see thumbnailImages): a row stays bounded and is tiny next to the call it
// describes.
//
// WHEN IT DOES NOT FIT, the shortening happens INSIDE the strings, never to the
// serialised JSON. Slicing the JSON was the old behaviour and it cost the whole
// feature: the stored text was no longer parseable, so the viewer's pretty
// renderer silently fell back to raw and its Pretty/Raw toggle disappeared
// (it only offers the choice when there are two ways to see it). An operator
// opening a long Cobb chat got one wall of escaped JSON, cut mid-word, with no
// control to fix it — the exact thing the pretty view exists to prevent
// (2026-08-20). Trimming the strings keeps the envelope — the roles, the turn
// boundaries, the small fields — structurally intact, so the record is still a
// record.
export function fullText(obj: unknown, cap = 40_000): string {
  const replacer = (k: string, v: unknown): unknown => {
    // A thumbnail this code made is small on purpose — keep it, so the viewer
    // can show what was sent. Anything else under an image key is the original
    // bytes and must not be stored.
    if (k === "image_b64" || k === "images" || k === "image") {
      return typeof v === "string" && v.startsWith("data:image/") && v.length <= THUMB_MAX_CHARS
        ? v
        : "[image]";
    }
    if (typeof v === "string" && looksLikeBlob(v)) {
      return `${v.slice(0, 120)}…[${v.length.toLocaleString()} chars of data]`;
    }
    return v;
  };

  const json = JSON.stringify(obj, replacer);
  if (!json) return "";
  if (json.length <= cap) return json;

  // Over budget. Shrink the longest strings until it fits, sharing the budget
  // between them rather than sacrificing whichever happened to serialise last.
  // Converges because each pass halves the allowance; the floor stops it from
  // spinning on a payload made entirely of tiny fields.
  for (let allowance = 8_000; allowance >= 250; allowance = Math.floor(allowance / 2)) {
    const shrunk = JSON.stringify(obj, (k, v) => {
      const out = replacer(k, v);
      return typeof out === "string" ? elide(out, allowance) : out;
    });
    if (shrunk && shrunk.length <= cap) return shrunk;
  }

  // Nothing but structure left (thousands of keys, no long strings). Slicing is
  // now the only lever, and the viewer handles unparseable text by rendering it
  // as prose — it just cannot offer the tree.
  return json.slice(0, cap) + "…[truncated]";
}
