// The import's photo download, kept free of the db so a test can drive it.
//
// A member names the URL, so it goes out through the same pinned, hop-by-hop
// guard as every other picture fetch (guardedImageFetch): each redirect is
// resolved and checked on its own and the connection is held to the address
// that was checked. What comes back is stored as a file the member can open,
// so it must be a picture.
import { guardedImageFetch } from "./enrich.js";

export const PHOTO_TIMEOUT_MS = 10_000;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedPhoto {
  bytes: Uint8Array;
  mime: string;
}

const HEADERS = { "user-agent": "cobblr-core-scan-import/1" };

/** The kind of picture these bytes are, by their first bytes; null if none. */
function sniffedImageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function get(url: string): Promise<Response> {
  // The test suite spins a loopback photo server and CI sets
  // COBBLR_TEST_CALLBACK_HOST; that one host is fetched as it is, and never
  // followed anywhere else.
  const testHost = process.env.COBBLR_TEST_CALLBACK_HOST;
  if (testHost && new URL(url).hostname === testHost) {
    // EGRESS: operator-configured - only the host the CI environment names (COBBLR_TEST_CALLBACK_HOST), and a redirect from it is refused
    const res = await fetch(url, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) throw new Error("blocked: the test host redirected");
    return res;
  }
  return guardedImageFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
}

export async function fetchImportPhoto(url: string): Promise<FetchedPhoto> {
  let res: Response;
  try {
    res = await get(url);
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
    const tailnet = /\.ts\.net(\/|:|$)/.test(url) ? " (a *.ts.net tailnet URL — reachable only if this Cobblr is on the same tailnet; rehost the photos or re-run the import from a tailnet-connected instance)" : "";
    throw new Error(`fetch failed: ${msg}${tailnet}`);
  }
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > PHOTO_MAX_BYTES) throw new Error(`photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const blob = await res.blob();
  if (blob.size > PHOTO_MAX_BYTES) throw new Error(`photo larger than ${PHOTO_MAX_BYTES / 1024 / 1024}MB cap`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const declared = (blob.type || res.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
  if (declared.startsWith("image/")) return { bytes, mime: declared };
  // A host that serves pictures untyped (or as a download) is still a picture host.
  const sniffed = !declared || declared === "application/octet-stream" ? sniffedImageType(bytes) : null;
  if (sniffed) return { bytes, mime: sniffed };
  throw new Error(`the link is not a picture (${declared || "no content type"})`);
}
