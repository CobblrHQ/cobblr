import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api, subscribeDeletedRecord } from "../lib/api";

export function DeletedRecordUndo() {
  const toast = useToast();
  const qc = useQueryClient();
  const { mutateAsync: restore } = useMutation({ mutationFn: async ({ slug, id }: { slug: string; id: string }) => {
    await api.request("POST", `/orgs/${slug}/deleted-records/${id}/restore`);
    await qc.invalidateQueries();
  } });
  useEffect(() => subscribeDeletedRecord(({ slug, id }) => {
    toast.action("Moved to Recently deleted for 30 days.", { actionLabel: "Undo", duration: 10_000, onAction: async () => {
      try {
        await restore({ slug, id });
        toast.success("Restored.");
      } catch (err) { toast.error((err as Error).message); }
    } });
  }), [toast, restore]);
  return null;
}
