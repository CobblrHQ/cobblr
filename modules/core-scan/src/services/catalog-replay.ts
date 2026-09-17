// Record once, replay forever: a file-backed answer for the product and book
// catalogs, so a test never depends on a live external catalog.
//
// The AI providers have had this for months (the replay provider and its
// cassettes); the barcode chain did not, and main went red three times in one
// morning on a test that scanned a real ISBN: the product lookup answered
// from a cache with the title, the book's own bag (author, year) needed a
// second live call to Open Library, and that call was throttled (#2992). A
// catalog that can be throttled is not a fixture.
//
// With COBBLR_CATALOG_REPLAY_DIR set, every catalog door (the product lookup
// chain, the ISBN and ASIN lookups) reads `<dir>/<code>.json` and NEVER
// touches the network: a code with no cassette is a miss, which is exactly
// what a synthetic test code should be. The catalogs' pictures are the same
// kind of dependence (a burst of ten book covers is throttled by their CDN,
// and a sandbox test counted 2 of 10), so the guarded image fetch reads
// `<dir>/images/<sha1 of the url>.<ext>` the same way: recorded once, a
// picture with no file is a 404. With COBBLR_CATALOG_REPLAY_RECORD=1
// as well, the live chain runs and its answer is written as the cassette, so
// a new real code is recorded once on a box that can reach the catalogs and
// replayed from then on. One file per code; the richest answer wins, since
// the ISBN door writes after the product chain and carries the bag.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BarcodeHit, BarcodeOutcome } from "./barcode-lookup.js";

export type CatalogCassette = BarcodeOutcome;

export function catalogReplayDir(): string | null {
  const dir = process.env.COBBLR_CATALOG_REPLAY_DIR?.trim();
  return dir ? dir : null;
}

export function catalogRecording(): boolean {
  return !!catalogReplayDir() && /^(1|true|yes)$/i.test(process.env.COBBLR_CATALOG_REPLAY_RECORD ?? "");
}

/** The cassette's file name: digits and an ISBN-10's X, nothing else. */
export function cassetteKey(code: string): string {
  return code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** Which catalog door is asking. The product chain and the book catalog
 *  can answer one code differently (a junk Open Food Facts entry for an
 *  ISBN, and Open Library's book, #3162), so the book door has a cassette
 *  of its own, `<code>.book.json`, and falls back to the code's one file
 *  when none was recorded: every cassette recorded before this reads as it
 *  did. The product chain keeps `<code>.json`. */
export type CatalogDoor = "product" | "book";

/** The catalogs that know BOOKS. An ISBN answered by any other source is a
 *  product catalog's stray entry until the book catalog has been asked
 *  (enrich.ts applies that; the book door's cassette fallback reads it). */
const BOOK_SOURCES = new Set(["openlibrary", "googlebooks", "isbndb", "worldcat"]);
export const isBookSource = (source: string): boolean => BOOK_SOURCES.has(source);

function cassetteFile(code: string, door: CatalogDoor): string {
  return door === "book" ? `${cassetteKey(code)}.book.json` : `${cassetteKey(code)}.json`;
}

/** The recorded answer for a code, or null when the dir is not set or holds
 *  nothing for it. A recording session reads nothing, so the live chain runs.
 *  The book door's fallback to the code's one file takes only a book
 *  source's answer (or a miss): a product cassette is the other door's
 *  answer, and handing it to the book door would say the book catalog
 *  knows a code it was never asked about. */
export function readCatalogCassette(code: string, door: CatalogDoor = "product"): CatalogCassette | null {
  const dir = catalogReplayDir();
  if (!dir || catalogRecording()) return null;
  const own = join(dir, cassetteFile(code, door));
  const fellBack = !existsSync(own);
  const file = fellBack ? join(dir, cassetteFile(code, "product")) : own;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CatalogCassette;
    if (fellBack && door === "book" && parsed.outcome === "hit" && !isBookSource(parsed.hit.source)) return null;
    return parsed && typeof parsed === "object" && "outcome" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/** Replay mode with no cassette: a miss, deterministically. Null when the
 *  door should ask the live catalog (no dir, or recording). */
export function replayMiss(code: string, door: CatalogDoor = "product"): BarcodeOutcome | null {
  if (!catalogReplayDir() || catalogRecording()) return null;
  return readCatalogCassette(code, door) ?? { outcome: "miss" };
}

export function writeCatalogCassette(code: string, answer: CatalogCassette, door: CatalogDoor = "product"): void {
  const dir = catalogReplayDir();
  if (!dir || !catalogRecording()) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, cassetteFile(code, door)), JSON.stringify(answer, null, 2) + "\n");
}

/** A live hit from a door, as a cassette. */
export function hitCassette(hit: BarcodeHit | null): CatalogCassette {
  return hit ? { outcome: "hit", hit } : { outcome: "miss" };
}

const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
const EXT_TYPE: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_EXT).map(([t, e]) => [e, t]));

export function imageCassetteKey(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

/** The recorded picture for a url, as a Response; a 404 when the dir is set
 *  and holds none; null when the fetch should go live (no dir, or recording). */
export function replayImage(url: string): Response | null {
  const dir = catalogReplayDir();
  if (!dir || catalogRecording()) return null;
  const images = join(dir, "images");
  const key = imageCassetteKey(url);
  const file = existsSync(images) ? readdirSync(images).find((f) => f.startsWith(`${key}.`)) : undefined;
  if (!file) return new Response(null, { status: 404, statusText: "no image cassette" });
  const ext = file.slice(key.length + 1);
  const bytes = readFileSync(join(images, file));
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": EXT_TYPE[ext] ?? "application/octet-stream", "content-length": String(bytes.length) } });
}

/** A live picture, kept for the next run. Reads the body once and hands back
 *  a Response the caller can still consume. */
export async function recordImage(url: string, res: Response): Promise<Response> {
  const dir = catalogReplayDir();
  if (!dir || !catalogRecording() || !res.ok) return res;
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const ext = IMAGE_EXT[type];
  if (!ext) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const images = join(dir, "images");
  mkdirSync(images, { recursive: true });
  writeFileSync(join(images, `${imageCassetteKey(url)}.${ext}`), bytes);
  return new Response(bytes, { status: res.status, headers: { "content-type": type, "content-length": String(bytes.length) } });
}
