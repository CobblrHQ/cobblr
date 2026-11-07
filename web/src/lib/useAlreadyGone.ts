// "Already gone": a perishable from an old receipt would be filed past its
// date. The filing doors hold it and say so; this is the one answer they
// offer beside filing the rest. It resolves the rows without adding stock,
// and Undo reopens them (#9274).
import { useToast } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const PAST_SHELF_LIFE = "past_shelf_life";

export function useAlreadyGone(slug: string) {
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries();
  /** Resolve these without adding stock; the toast carries the Undo. */
  const now = async (ids: string[]) => {
    try {
      const r = await api.markScanAlreadyGone(slug, ids);
      refresh();
      const done = r.already_gone;
      if (!done.length) {
        toast.error(r.failed[0]?.reason ?? "Nothing was marked gone.");
        return;
      }
      toast.action(`${countOf(done.length, "item")} marked already gone. Nothing was added to stock.`, {
        actionLabel: "Undo",
        duration: 10000,
        onAction: async () => {
          for (const id of done) await api.unconfirmScanItem(slug, id).catch(() => undefined);
          refresh();
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't mark those gone");
    }
  };
  /** Say how many are past their shelf life and offer "Already gone" for them. */
  const offer = (ids: string[]) => {
    if (!ids.length) return;
    const n = ids.length;
    toast.action(`${countOf(n, "item")} from an old receipt would be filed already past ${n === 1 ? "its" : "their"} date.`, {
      actionLabel: "Already gone",
      duration: 15000,
      onAction: () => void now(ids),
    });
  };
  return Object.assign(offer, { now });
}
