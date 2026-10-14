// Undo split, with its way back. Every door to it (a split line's ⋯, a
// piece's card, Recently committed) runs this, and its toast offers Split
// again for as long as it shows: one tap put the owner's split pack of ten
// back as one row, and the only way back was splitting it from scratch
// (#6527).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ScanInboxItem } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "./scan-inbox-keys";

export function useUndoSplit(opts: { onDone?: (parent: ScanInboxItem) => void } = {}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
  return useMutation({
    mutationFn: (id: string) => api.unsplitScanItem(activeSlug, id),
    onSuccess: (r) => {
      void refresh();
      opts.onDone?.(r.parent);
      toast.success(`Split undone: its ${r.discarded} part${r.discarded === 1 ? "" : "s"} ${r.discarded === 1 ? "is" : "are"} in Recently deleted.`, {
        actionLabel: "Split again",
        onAction: async () => {
          try {
            await api.redoSplitScanItem(activeSlug, r.parent.id);
            toast.success(`Split again into ${r.discarded}.`);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
          await refresh();
        },
      });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
}
