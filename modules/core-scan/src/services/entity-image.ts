// Auto-fetch a representative image for an entity from a text query — so the
// user does NOTHING. Reuses the exact pipeline that gives a scanned product its
// photo: DDG image search → pick the best title match → download into the
// workspace file store → set the entity's image_path. Best-effort + FREE (no AI).
//
// Used for 3D printers (query "<manufacturer> <model> 3D printer"), so a
// connected printer just shows its product photo. The image lands in the user's
// OWN file store (not bundled in the app), which also keeps us clear of shipping
// manufacturer photos.

import { platform } from "@cobblr/platform-contract";
import { pictureOptions } from "./picture-options.js";
import { pickPhotoOf } from "./shows-the-thing.js";
import { guardedImageFetch } from "./enrich.js";
import { curatedImageUrl } from "./curated-images.js";
import { browserImageHeaders } from "./image-fetch-headers.js";
import { deriveImageQuery } from "./ddg-images.js";
import { fileIdOfImagePath } from "./record-photo-searches.js";
import type { PhotoSource } from "@cobblr/platform-contract/photo-source";

// loopback-ok: #5153 moves this onto selfFetch
const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Why a picture could not be kept, in words for the person who picked it. */
export type StoreOutcome = { fileId: string } | { fileId: null; why: string };

/** Fetch an external image (SSRF-guarded, size/timeout-bounded) and store it in
 *  the workspace file store. Stores via the platform files seam (in-process),
 *  NOT the HTTP upload route: a system-fetched image is not a user upload, so
 *  it must bypass any gate on that route (e.g. the trial tier withholds user
 *  uploads). Never throws; a refusal says why. */
export async function storeImageFrom(orgId: string, imageUrl: string, photoSource?: PhotoSource): Promise<StoreOutcome> {
  try {
    const dl = await guardedImageFetch(imageUrl, { headers: browserImageHeaders(imageUrl), signal: AbortSignal.timeout(8_000) });
    if (!dl.ok) {
      if (dl.status === 401 || dl.status === 403) return { fileId: null, why: "That site doesn't allow its pictures to be saved elsewhere." };
      if (dl.status === 404 || dl.status === 410) return { fileId: null, why: "That picture is no longer on the site it came from." };
      return { fileId: null, why: `That site answered with an error (${dl.status}) instead of the picture.` };
    }
    const declared = Number(dl.headers.get("content-length") ?? 0);
    if (declared && declared > MAX_IMAGE_BYTES) return { fileId: null, why: "That picture is too large to keep (over 10 MB)." };
    const blob = await dl.blob();
    if (blob.size > MAX_IMAGE_BYTES) return { fileId: null, why: "That picture is too large to keep (over 10 MB)." };
    if (blob.size === 0 || (blob.type && !blob.type.startsWith("image/"))) return { fileId: null, why: "That address gave back a page, not a picture." };
    const name = (imageUrl.split("/").pop() ?? "image").split("?")[0] || "image.jpg";
    const written = await platform().files.write(orgId, new Uint8Array(await blob.arrayBuffer()), {
      filename: name,
      mimeType: blob.type || "image/jpeg",
      photoSource: photoSource ?? { kind: "web", original_url: imageUrl, at: new Date().toISOString() },
    });
    return written?.fileId ? { fileId: written.fileId } : { fileId: null, why: "The picture came, but storing it failed." };
  } catch (err) {
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") return { fileId: null, why: "That site took too long to send the picture." };
    if (e.name === "StockPreviewRefused") return { fileId: null, why: "That is a stock agency's watermarked preview." };
    if (/blocked/i.test(e.message)) return { fileId: null, why: "That address can't be reached from here." };
    return { fileId: null, why: "That site couldn't be reached." };
  }
}

/** storeImageFrom, for a caller that only needs the file. */
export async function fetchAndStoreImage(orgId: string, imageUrl: string): Promise<string | null> {
  return (await storeImageFrom(orgId, imageUrl)).fileId;
}

/** Keep the picture a person picked from a strip. The strip shows each
 *  picture through its search engine's copy; the pick names the original. A
 *  host that will not hand its original to another server (hotlink rules, a
 *  403) still showed the person a picture, so that picture is what is kept.
 *  Only when neither comes does it say no, with the reason. */
export async function storePickedImage(orgId: string, url: string, shownUrl?: string | null, photoSource?: PhotoSource): Promise<StoreOutcome> {
  // The copy shown is still the picture at `url`: the file says that address.
  const source = photoSource ?? { kind: "web" as const, original_url: url, at: new Date().toISOString() };
  const original = await storeImageFrom(orgId, url, source);
  if (original.fileId || !shownUrl || shownUrl === url) return original;
  const shown = await storeImageFrom(orgId, shownUrl, source);
  return shown.fileId ? shown : original;
}

/** Search the web for a representative image of `query`, store the best match in
 *  the file store, and set it as `entityKind:entityId`'s image_path. Returns the
 *  new image_path, or null. Best-effort: never throws. */
export async function enrichEntityImage(opts: {
  orgId: string;
  orgSlug: string;
  bearer: string;
  entityKind: string;
  entityId: string;
  query: string;
  /** For an INSTANCE entity (e.g. a machine in the "3d-printers" instance) the
   *  CRUD route is /instances/<instance>/items/<id>, not the base module route —
   *  the base PATCH filters by instance and would 404. */
  instance?: string | null;
  /** A SPECIFIC image url the user picked (interactive web-image picker). When
   *  set, skip the curated/search auto-pick and store exactly this one. */
  imageUrl?: string | null;
  /** The record's own name and maker, for judging a searched picture. */
  name?: string | null;
  brand?: string | null;
}): Promise<string | null> {
  try {
    const [moduleName, type] = opts.entityKind.split(":");
    if (!moduleName || !type) return null;
    // A user-picked url wins outright. Otherwise: curated catalog first
    // (hand-picked, correct model), then the DDG image search (best-effort).
    let imageUrl = opts.imageUrl ?? null;
    if (!imageUrl) {
      imageUrl = await curatedImageUrl(opts.query);
      if (!imageUrl) {
        const results = (await pictureOptions({ query: opts.query })).items;
        imageUrl = pickPhotoOf(results, { name: opts.name ?? opts.query, brand: opts.brand ?? null })?.url ?? null;
      }
    }
    if (!imageUrl) return null;
    const fileId = (await storeImageFrom(opts.orgId, imageUrl, { kind: "web", original_url: imageUrl, query: opts.query, at: new Date().toISOString() })).fileId;
    if (!fileId) return null;
    return setEntityImageFile({ ...opts, fileId });
  } catch (err) {
    console.error("[core-scan] entity-image enrich failed:", (err as Error).message);
    return null;
  }
}

/** The image_path a stored file renders at. One spelling, because the scan
 *  inbox, the entity picker and this module's own enrich all point records at
 *  the same file store. */
export function imagePathForFile(orgSlug: string, fileId: string): string {
  return `/api/v1/orgs/${orgSlug}/modules/core-files/files/${fileId}/raw?variant=medium`;
}

/** Point an entity at a file ALREADY in the store: a scan's catalog picture
 *  handed to the record it matched, with no second download. The "Already
 *  tracked" banner offers this when the tracked record has no picture and the
 *  scan just found one. Best-effort like the enrich; null on any failure. */
export async function setEntityImageFile(opts: {
  orgSlug: string;
  bearer: string;
  entityKind: string;
  entityId: string;
  instance?: string | null;
  fileId: string;
}): Promise<string | null> {
  const imagePath = imagePathForFile(opts.orgSlug, opts.fileId);
  return (await setEntityImagePath(opts, imagePath)) ? imagePath : null;
}

/** PATCH a record's image_path to exactly this value (a file's address, an
 *  older outside address being put back by Undo, or nothing). */
export async function setEntityImagePath(
  opts: { orgSlug: string; bearer: string; entityKind: string; entityId: string; instance?: string | null },
  imagePath: string | null,
): Promise<boolean> {
  try {
    const [moduleName, type] = opts.entityKind.split(":");
    if (!moduleName || !type) return false;
    // Set image_path via the entity's CRUD route (loopback only, carries the
    // bearer). Instance items live under /instances/<instance>/items/<id>.
    const route = opts.instance
      ? `/api/v1/orgs/${opts.orgSlug}/instances/${opts.instance}/items/${opts.entityId}`
      : `/api/v1/orgs/${opts.orgSlug}/modules/${moduleName}/${type}s/${opts.entityId}`;
    const patch = await fetch(`${INTERNAL_API}${route}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${opts.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_path: imagePath }),
    });
    return patch.ok;
  } catch (err) {
    console.error("[core-scan] entity-image set failed:", (err as Error).message);
    return false;
  }
}

/** Make a stored picture the record's main photo, keeping the one it had.
 *
 *  The photo it replaces is never thrown away: it is put in the record's
 *  photos (an attachment), where it stays one tap from being main again. The
 *  owner's main picture was a VIN label he needed; AI Pick replacing it must
 *  not lose it (#4515). The new one is attached too, so the strip shows every
 *  picture the record has had, the main one first. Returns the address the
 *  record had, for Undo. */
export async function setMainPhoto(opts: {
  orgId: string;
  orgSlug: string;
  bearer: string;
  entityKind: string;
  entityId: string;
  instance?: string | null;
  fileId: string;
}): Promise<{ image_path: string; previous_image_path: string | null } | null> {
  const [sourceModule, sourceType] = opts.entityKind.split(":");
  if (!sourceModule || !sourceType) return null;
  const before = await platform().entities.lookup(opts.orgId, opts.entityKind, opts.entityId).catch(() => null);
  const previous = (before?.image_path ?? (before?.fields as { image_path?: unknown } | undefined)?.image_path ?? null) as string | null;
  // An item in a collection is changed through the collection's own route.
  const instance = opts.instance ?? before?.instance ?? null;
  const keep = async (fileId: string) => {
    await platform()
      .files.attach(opts.orgId, { fileId, source_module: sourceModule, source_type: sourceType, source_id: opts.entityId, role: "gallery" })
      .catch((err: Error) => console.error("[core-scan] keeping a photo on the record failed:", err.message));
  };
  const previousFile = fileIdOfImagePath(previous);
  if (previousFile && previousFile !== opts.fileId) await keep(previousFile);
  await keep(opts.fileId);
  const image_path = await setEntityImageFile({ ...opts, instance });
  return image_path ? { image_path, previous_image_path: previous || null } : null;
}

/** The image-search phrase for an entity, derived server-side from its own
 *  name / brand / fields. Shared by the options strip and the auto-fetch so
 *  they can never search differently for the same thing. */
export async function derivedQueryFor(
  orgId: string,
  kind: string,
  id: string,
  override?: string | null,
): Promise<{ query: string | null; brand: string | null; name: string | null; resolved: boolean }> {
  const e = await platform().entities.lookup(orgId, kind, id).catch(() => null);
  // `resolved` separates "this kind has no single-entity resolver" (a wiring
  // gap) from "resolved fine but there's nothing to search for" (a data gap).
  if (!e) return { query: (override ?? "").trim() || null, brand: null, name: null, resolved: false };
  const fields = (e.fields ?? {}) as Record<string, unknown>;
  // The custom-field bag lives under `metadata` for the physical kinds; merge
  // it so a declared author/director/colour sharpens the phrase just like a
  // native column does.
  const meta = (fields.metadata ?? {}) as Record<string, unknown>;
  const merged = { ...meta, ...fields };
  const brand = typeof merged.manufacturer === "string" ? (merged.manufacturer as string) : null;
  const laser = "bed_size_laser" in merged || "tube_type" in merged;
  const model = typeof merged.family === "string" ? merged.family.trim() : "";
  const hardwareName = laser ? model && brand?.trim() ? `${model} laser cutter` : null : e.title;
  return {
    query: deriveImageQuery({ name: hardwareName, brand, fields: merged, override: override ?? null, collection: e.instance ?? null }),
    brand,
    name: e.title,
    resolved: true,
  };
}
