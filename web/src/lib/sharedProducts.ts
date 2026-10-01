// Adding what a person shared or pasted from a shopping app: one inbox item
// per product, the link as its source and the words it came with as its name
// (parseSharedText, @cobblr/platform-contract/shared-text). The scan box, a
// paste anywhere on the inbox and the share target (/scan/share) all add
// through here, so the three can never keep the title differently.
import type { SharedProduct } from "@cobblr/platform-contract/shared-text";
import { api, ApiError } from "./api";

export interface AddedShared {
  ok: number;
  of: number;
  /** Why the last one that failed failed, kept so a failure is never a
   *  green "Added 0". */
  lastError: string | null;
}

export async function addSharedProducts(
  slug: string,
  products: SharedProduct[],
  opts: { target_location_id?: string; scan_batch_id?: string } = {},
): Promise<AddedShared> {
  let ok = 0;
  let lastError: string | null = null;
  for (const p of products.slice(0, 50)) {
    try {
      await api.scanBarcode(slug, {
        source_kind: "url",
        source_url: p.url,
        ...(p.title ? { shared_title: p.title } : {}),
        ...(opts.target_location_id ? { target_location_id: opts.target_location_id } : {}),
        ...(opts.scan_batch_id ? { scan_batch_id: opts.scan_batch_id } : {}),
      });
      ok++;
    } catch (e) {
      lastError = e instanceof ApiError ? e.message : String(e);
    }
  }
  return { ok, of: Math.min(products.length, 50), lastError };
}

/** The sentence a person reads after adding: zero is a failure whatever the
 *  loop did, some is an info that says how many, all is a success. */
export function addedSharedMessage(r: AddedShared): { tone: "error" | "info" | "success"; text: string } {
  const noun = (n: number) => (n === 1 ? "link" : "links");
  if (r.ok === 0) {
    return {
      tone: "error",
      text: (r.of === 1 ? "Couldn't add that link" : `Couldn't add any of those ${r.of} links`) + (r.lastError ? `: ${r.lastError}` : "."),
    };
  }
  if (r.ok < r.of) {
    return { tone: "info", text: `Added ${r.ok} of ${r.of} links - identifying in the inbox.` + (r.lastError ? ` The rest failed: ${r.lastError}` : "") };
  }
  return { tone: "success", text: `Added ${r.ok} ${noun(r.ok)} - identifying in the inbox.` };
}
