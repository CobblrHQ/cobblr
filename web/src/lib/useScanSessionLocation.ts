import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "./api";
import { scanInboxKeys } from "./scan-inbox-keys";

type InboxPage = Awaited<ReturnType<typeof api.listScanInbox>>;

export function useScanSessionLocation(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: scanInboxKeys.locationSave(slug),
    mutationFn: async ({ ids, locationId }: { ids: string[]; locationId: string }) => {
      const saved = new Map<string, string | null>();
      let lastErr: string | null = null;
      for (const id of ids) {
        try {
          const row = await api.updateScanItem(slug, id, { target_location_id: locationId });
          saved.set(id, row.target_location_id);
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      // Keep the acknowledged choice even if the following refresh fails.
      await qc.cancelQueries({ queryKey: scanInboxKeys.pendingLists(slug) });
      qc.setQueriesData<InfiniteData<InboxPage>>({ queryKey: scanInboxKeys.pendingLists(slug) }, (old) => old ? {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((row) => {
            const locationId = saved.get(row.id);
            return locationId === undefined ? row : { ...row, target_location_id: locationId };
          }),
        })),
      } : old);
      return { ok: saved.size, lastErr };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) }),
  });
}
