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
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { parseSharedText } from "@cobblr/platform-contract/shared-text";
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
}

interface KeptPayload {
  title?: string;
  text?: string;
  url?: string;
  files?: Array<{ key: string; name: string; type: string }>;
}

/** What was shared: the worker's kept form, taken once, or the address. */
export async function readShare(search: string): Promise<ReceivedShare | null> {
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(SHARE_CACHE);
      const kept = await cache.match(SHARE_PAYLOAD);
      if (kept) {
        const p = (await kept.json()) as KeptPayload;
        const files: File[] = [];
        for (const f of p.files ?? []) {
          const body = await cache.match(f.key);
          if (body) files.push(new File([await body.blob()], f.name, { type: f.type }));
        }
        await caches.delete(SHARE_CACHE);
        return { title: p.title ?? "", text: p.text ?? "", url: p.url ?? "", files };
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

/** Add one share to the inbox. Returns the sentence the person reads. */
export async function addShare(slug: string, share: ReceivedShare): Promise<{ tone: "error" | "info" | "success"; text: string }> {
  const products = parseSharedText({ title: share.title, text: share.text, url: share.url });
  let photos = 0;
  let photoError: string | null = null;
  for (const file of share.files) {
    try {
      const rec = await api.uploadFile(slug, file);
      await api.scanBarcode(slug, { source_kind: "photo", image_file_id: rec.id });
      photos++;
    } catch (e) {
      photoError = e instanceof Error ? e.message : String(e);
    }
  }
  if (products.length === 0) {
    if (photos > 0) return { tone: "success", text: `Added ${photos} photo${photos === 1 ? "" : "s"} - identifying in the inbox.` };
    if (photoError) return { tone: "error", text: `Couldn't add that photo: ${photoError}` };
    return { tone: "error", text: "Nothing to add: share a product with its link, or a photo of it." };
  }
  const said = addedSharedMessage(await addSharedProducts(slug, products));
  return photos > 0 ? { ...said, text: `${said.text} And ${photos} photo${photos === 1 ? "" : "s"}.` } : said;
}

export function ShareReceivePage() {
  usePageTitle("Adding what you shared");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [state, setState] = useState<"adding" | "nothing">("adding");
  const ran = useRef(false);

  useEffect(() => {
    if (!activeSlug || ran.current) return;
    ran.current = true;
    void (async () => {
      const share = await readShare(window.location.search);
      if (!share) {
        setState("nothing");
        return;
      }
      const said = await addShare(activeSlug, share);
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast[said.tone](said.text);
      navigate("/scan", { replace: true });
    })();
  }, [activeSlug, navigate, qc, toast]);

  return (
    <div className="mx-auto max-w-md px-4 py-10 text-center">
      {state === "adding" ? (
        <p className="text-sm text-muted">Adding what you shared to the inbox…</p>
      ) : (
        <>
          <p className="text-sm text-content">There was nothing to add here.</p>
          <p className="mt-2 text-sm text-muted">Share a product from a shopping app to {productName()}, or paste its title and link into the inbox.</p>
          <button type="button" onClick={() => navigate("/scan")} className="mt-4 rounded bg-cobble-600 hover:bg-cobble-700 px-3 py-1.5 text-sm text-white">
            Open the inbox
          </button>
        </>
      )}
    </div>
  );
}
