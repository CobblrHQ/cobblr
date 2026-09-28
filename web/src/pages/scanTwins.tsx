// Two items waiting in the inbox that are the same picture (#3852).
//
// A screenshot pasted twice, because the first paste showed nothing, made two
// identical items. The server stamps each photo row with its picture's hash
// (`image_sha256`); the inbox finds pending rows that share one and offers
// to keep one. Nothing is removed until the person says which.

import { createContext, useContext, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, type ScanInboxItem } from "../lib/api";
import { scanInboxKeys } from "../lib/scan-inbox-keys";

/** Pending rows that share a picture with another pending row: id → its
 *  twins' ids. Pure. */
export function twinsOf(rows: ReadonlyArray<Pick<ScanInboxItem, "id" | "status" | "suggested_metadata">>): Map<string, string[]> {
  const byHash = new Map<string, string[]>();
  for (const r of rows) {
    if (r.status !== "pending") continue;
    const h = (r.suggested_metadata as { image_sha256?: unknown } | null)?.image_sha256;
    if (typeof h !== "string" || !h) continue;
    byHash.set(h, [...(byHash.get(h) ?? []), r.id]);
  }
  const out = new Map<string, string[]>();
  for (const ids of byHash.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out.set(id, ids.filter((x) => x !== id));
  }
  return out;
}

export const ScanTwinsContext = createContext<Map<string, string[]>>(new Map());

export const TWIN_SENTENCE = "The same picture is waiting here twice.";

/** "Keep this one" puts the copies aside (the inbox's own discard, which
 *  Recently deleted can undo); "They're different" stops asking here. */
export function SamePictureOffer({ slug, itemId }: { slug: string; itemId: string }) {
  const twins = useContext(ScanTwinsContext).get(itemId) ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const keep = useMutation({
    mutationFn: async () => {
      for (const id of twins) await api.discardScanItem(slug, id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });
      toast.success(twins.length === 1 ? "Kept this one. The copy is in Recently deleted." : `Kept this one. The ${twins.length} copies are in Recently deleted.`);
    },
    onError: () => toast.error("Couldn't set the copy aside. Try again."),
  });
  if (!twins.length || dismissed) return null;
  return (
    <div
      data-testid="same-picture-offer"
      onClick={(e) => e.stopPropagation()}
      className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300"
    >
      <Copy size={12} className="shrink-0" />
      <span>{TWIN_SENTENCE} Keep one?</span>
      <button type="button" disabled={keep.isPending} onClick={() => keep.mutate()} className="rounded bg-amber-600 px-2 py-0.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-60">
        Keep this one
      </button>
      <button type="button" onClick={() => setDismissed(true)} className="underline">
        They're different
      </button>
    </div>
  );
}
