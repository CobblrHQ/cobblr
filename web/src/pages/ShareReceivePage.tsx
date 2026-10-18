// /scan/share: where a product shared from another app lands (the manifests'
// share_target). On Android, and in desktop Chrome, an installed Cobblr shows
// in the share sheet; sharing a product from a shopping app sends its title
// and link (and any photo). The service worker keeps that form (sw/sw-logic.js)
// and opens this page, which alone holds the person's token, to add it: one
// inbox item per product, its title kept as the item's name and its link as
// the source (lib/sharedProducts.ts, the same add the scan box and an inbox
// paste use), and one photo item per shared picture. Then the inbox.
//
// A share that arrives as a plain link (?title=&text=&url=, no worker, or an
// app that shares by GET) is read from the address instead.
import { productName } from "@cobblr/platform-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { parseSharedText, type SharedProduct } from "@cobblr/platform-contract/shared-text";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { addSharedProducts, addedSharedMessage } from "../lib/sharedProducts";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
// @ts-expect-error a plain JS module shared with the service worker
import { SHARE_CACHE, SHARE_PAYLOAD } from "../sw/sw-logic.js";

export interface ReceivedShare {
  title: string;
  text: string;
  url: string;
  files: File[];
  /** Where each of `files` is kept (the worker's cache key), index for index. */
  keys?: string[];
  /** Products an earlier try still owes, parsed once: those already added
   *  are gone from it, so a retry never adds one twice. */
  products?: SharedProduct[];
}

interface KeptPayload {
  title?: string;
  text?: string;
  url?: string;
  products?: SharedProduct[];
  files?: Array<{ key: string; name: string; type: string }>;
}

/** What was shared: the worker's kept form (kept until it is all added or
 *  discarded, so a reload resumes it), or the address. */
export async function readShare(search: string): Promise<ReceivedShare | null> {
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(SHARE_CACHE);
      const kept = await cache.match(SHARE_PAYLOAD);
      if (kept) {
        const p = (await kept.json()) as KeptPayload;
        const files: File[] = [];
        const keys: string[] = [];
        for (const f of p.files ?? []) {
          const body = await cache.match(f.key);
          if (body) {
            files.push(new File([await body.blob()], f.name, { type: f.type }));
            keys.push(f.key);
          }
        }
        return { title: p.title ?? "", text: p.text ?? "", url: p.url ?? "", files, keys, ...(p.products ? { products: p.products } : {}) };
      }
    }
  } catch {
    // No Cache API here, or it failed: the address is all there is.
  }
  const q = new URLSearchParams(search);
  const title = q.get("title") ?? "";
  const text = q.get("text") ?? "";
  const url = q.get("url") ?? "";
  return title || text || url ? { title, text, url, files: [] } : null;
}

export interface ShareOutcome {
  tone: "error" | "info" | "success";
  text: string;
  /** What is still to add: only the products and photos that failed. Null
   *  when everything was added. */
  remaining: ReceivedShare | null;
}

/** What is left of a share once the ones added are taken out. Pure. */
export function remainingShare(share: ReceivedShare, failedProducts: SharedProduct[], failedFiles: number[]): ReceivedShare | null {
  if (failedProducts.length === 0 && failedFiles.length === 0) return null;
  return {
    title: "",
    text: "",
    url: "",
    products: failedProducts,
    files: failedFiles.map((i) => share.files[i]!),
    ...(share.keys ? { keys: failedFiles.map((i) => share.keys![i]!) } : {}),
  };
}

/** Keep what is still to add where a reload finds it, or let the share go. */
export async function settleShare(remaining: ReceivedShare | null): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    if (!remaining) {
      await caches.delete(SHARE_CACHE);
      return;
    }
    const cache = await caches.open(SHARE_CACHE);
    const files: NonNullable<KeptPayload["files"]> = [];
    for (const [i, f] of remaining.files.entries()) {
      const key = remaining.keys?.[i] ?? `/__share/file/retry-${i}`;
      if (!remaining.keys?.[i]) await cache.put(key, new Response(f));
      files.push({ key, name: f.name, type: f.type });
    }
    const payload: KeptPayload = { products: remaining.products ?? [], files };
    await cache.put(SHARE_PAYLOAD, new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
  } catch {
    // No Cache API: the page still holds what is left for Try again.
  }
}

const photos = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;

/** Add one share to the inbox: the sentence the person reads, and what is
 *  left when some of it failed, kept where a reload finds it. */
export async function addShare(slug: string, share: ReceivedShare): Promise<ShareOutcome> {
  const out = await addEach(slug, share);
  await settleShare(out.remaining);
  return out;
}

async function addEach(slug: string, share: ReceivedShare): Promise<ShareOutcome> {
  const products = [...(share.products ?? []), ...parseSharedText({ title: share.title, text: share.text, url: share.url })];
  let added = 0;
  let photoError: string | null = null;
  const failedFiles: number[] = [];
  for (const [i, file] of share.files.entries()) {
    try {
      const rec = await api.uploadFile(slug, file);
      await api.scanBarcode(slug, { source_kind: "photo", image_file_id: rec.id });
      added++;
    } catch (e) {
      photoError = e instanceof Error ? e.message : String(e);
      failedFiles.push(i);
    }
  }
  const lost = failedFiles.length;
  if (products.length === 0) {
    const remaining = remainingShare(share, [], failedFiles);
    if (lost === 0 && added > 0) return { tone: "success", text: `Added ${photos(added)} - identifying in the inbox.`, remaining };
    if (lost > 0 && added > 0) return { tone: "info", text: `Added ${added} of ${photos(added + lost)}. ${lost === 1 ? "One" : lost} didn't save: ${photoError}`, remaining };
    if (lost > 0) return { tone: "error", text: `Couldn't add ${lost === 1 ? "that photo" : `those ${photos(lost)}`}: ${photoError}`, remaining };
    return { tone: "error", text: "Nothing to add: share a product with its link, or a photo of it.", remaining: null };
  }
  const result = await addSharedProducts(slug, products);
  const remaining = remainingShare(share, result.failed, failedFiles);
  const said = addedSharedMessage(result);
  if (share.files.length === 0) return { ...said, remaining };
  const photoLine = lost === 0 ? ` And ${photos(added)}.` : added > 0 ? ` ${photos(added)} added, ${lost} didn't save: ${photoError}` : ` The ${photos(lost)} didn't save: ${photoError}`;
  const tone = lost === 0 ? said.tone : result.ok === 0 && added === 0 ? "error" : "info";
  return { tone, text: `${said.text}${photoLine}`, remaining };
}

export function ShareReceivePage() {
  usePageTitle("Adding what you shared");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [state, setState] = useState<"adding" | "nothing" | { said: string; tone: ShareOutcome["tone"]; remaining: ReceivedShare }>("adding");
  const ran = useRef(false);

  const add = useCallback(
    async (slug: string, share: ReceivedShare) => {
      setState("adding");
      const out = await addShare(slug, share);
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });
      if (!out.remaining) {
        toast[out.tone](out.text);
        navigate("/scan", { replace: true });
        return;
      }
      setState({ said: out.text, tone: out.tone, remaining: out.remaining });
    },
    [navigate, qc, toast],
  );

  useEffect(() => {
    if (!activeSlug || ran.current) return;
    ran.current = true;
    void (async () => {
      const share = await readShare(window.location.search);
      if (!share) {
        setState("nothing");
        return;
      }
      await add(activeSlug, share);
    })();
  }, [activeSlug, add]);

  const discard = async () => {
    await settleShare(null);
    navigate("/scan", { replace: true });
  };

  return (
    <div className="mx-auto max-w-md px-4 py-10 text-center">
      {state === "adding" ? (
        <p className="text-sm text-muted">Adding what you shared to the inbox…</p>
      ) : state === "nothing" ? (
        <>
          <p className="text-sm text-content">There was nothing to add here.</p>
          <p className="mt-2 text-sm text-muted">Share a product from a shopping app to {productName()}, or paste its title and link into the inbox.</p>
          <button type="button" onClick={() => navigate("/scan")} className="mt-4 rounded bg-cobble-600 hover:bg-cobble-700 px-3 py-1.5 text-sm text-white">
            Open the inbox
          </button>
        </>
      ) : (
        <div data-share-left="">
          <p role="alert" className={`text-sm ${state.tone === "error" ? "text-red-800 dark:text-red-300" : "text-content"}`}>
            {state.said}
          </p>
          <p className="mt-2 text-sm text-muted">What didn't save is kept here; trying again adds only that.</p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={() => activeSlug && void add(activeSlug, state.remaining)} className="rounded bg-cobble-600 hover:bg-cobble-700 px-3 py-1.5 text-sm text-white">
              Try again
            </button>
            <button type="button" onClick={() => void discard()} className="rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-800/40 px-3 py-1.5 text-sm text-content">
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
