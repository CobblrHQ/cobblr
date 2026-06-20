// Auto-fetch a representative image for an entity from a text query — so the
// user does NOTHING. Reuses the exact pipeline that gives a scanned product its
// photo: DDG image search → pick the best title match → download into the
// workspace file store → set the entity's image_path. Best-effort + FREE (no AI).
//
// Used for 3D printers (query "<manufacturer> <model> 3D printer"), so a
// connected printer just shows its product photo. The image lands in the user's
// OWN file store (not bundled in the app), which also keeps us clear of shipping
// manufacturer photos.

import { searchImages } from "./ddg-images.js";
import { pickImage } from "./barcode-websearch.js";
import { assertSafeOutboundUrl } from "./enrich.js";
import { curatedImageUrl } from "./curated-images.js";

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Fetch an external image (SSRF-guarded, size/timeout-bounded) and store it in
 *  the workspace file store; returns the new file id, or null on any failure. */
async function fetchAndStoreImage(orgSlug: string, bearer: string, imageUrl: string): Promise<string | null> {
  try {
    assertSafeOutboundUrl(imageUrl);
    const dl = await fetch(imageUrl, { headers: { "user-agent": "cobblr-core-scan/0.1" }, signal: AbortSignal.timeout(8_000) });
    if (!dl.ok) return null;
    const declared = Number(dl.headers.get("content-length") ?? 0);
    if (declared && declared > MAX_IMAGE_BYTES) return null;
    const blob = await dl.blob();
    if (blob.size > MAX_IMAGE_BYTES || blob.size === 0) return null;
    const name = (imageUrl.split("/").pop() ?? "image").split("?")[0] || "image.jpg";
    const fd = new FormData();
    fd.append("file", blob, name);
    const up = await fetch(`${INTERNAL_API}/api/v1/orgs/${orgSlug}/modules/core-files/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: fd,
    });
    if (!up.ok) return null;
    return ((await up.json()) as { id: string }).id;
  } catch {
    return null;
  }
}

/** Search the web for a representative image of `query`, store the best match in
 *  the file store, and set it as `entityKind:entityId`'s image_path. Returns the
 *  new image_path, or null. Best-effort: never throws. */
export async function enrichEntityImage(opts: {
  orgSlug: string;
  bearer: string;
  entityKind: string;
  entityId: string;
  query: string;
  /** For an INSTANCE entity (e.g. a machine in the "3d-printers" instance) the
   *  CRUD route is /instances/<instance>/items/<id>, not the base module route —
   *  the base PATCH filters by instance and would 404. */
  instance?: string | null;
}): Promise<string | null> {
  try {
    const [moduleName, type] = opts.entityKind.split(":");
    if (!moduleName || !type) return null;
    // Curated catalog first (hand-picked, correct model); fall back to the DDG
    // image search (best-effort, can guess the wrong model) only on a miss.
    let imageUrl = await curatedImageUrl(opts.query);
    if (!imageUrl) {
      const results = await searchImages(opts.query);
      imageUrl = pickImage(results, opts.query) ?? results[0]?.url ?? null;
    }
    if (!imageUrl) return null;
    const fileId = await fetchAndStoreImage(opts.orgSlug, opts.bearer, imageUrl);
    if (!fileId) return null;
    const imagePath = `/api/v1/orgs/${opts.orgSlug}/modules/core-files/files/${fileId}/raw?variant=medium`;
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
    if (!patch.ok) return null;
    return imagePath;
  } catch (err) {
    console.error("[core-scan] entity-image enrich failed:", (err as Error).message);
    return null;
  }
}
