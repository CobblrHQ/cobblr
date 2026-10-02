// A scan of something you already have, at a place it is not kept yet: one
// item, a row per place. In place of the count control, which would add these
// to the place it is kept already (8 in the kitchen, then 12 in the kitchen
// while four bins sit in the garage), the card says where it is and offers
// this place as another (#4552).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import type { ScanMergeTarget } from "@cobblr/platform-contract/scan-triage";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { addedPlaceSentence } from "../lib/scan-place-words";

export function AddPlaceBlock({
  itemId,
  merge,
  sentence,
  scanned,
  onDone,
}: {
  itemId: string;
  merge: ScanMergeTarget;
  /** The row's own sentence ("You already have …: 8 in Kitchen. Add these as another place?"). */
  sentence: string | null;
  scanned: number;
  onDone?: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () =>
      api.scanAttach(activeSlug, itemId, { kind: merge.kind, entity_id: merge.id, ...(merge.instance ? { instance: merge.instance } : {}), mode: "add-place", qty: scanned }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success(addedPlaceSentence(r.entity_title || merge.title, r.added_place ?? { location_name: null, qty: scanned }));
      onDone?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div data-testid="add-place" className="flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
      {sentence && <span className="text-content dark:text-mortar-100">{sentence}</span>}
      <button
        type="button"
        onClick={() => add.mutate()}
        disabled={add.isPending}
        title={`Adds a row for this place under ${merge.title}, with its own count`}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 font-medium disabled:opacity-50"
      >
        <MapPin size={11} /> {add.isPending ? "Adding…" : "Add as another place"}
      </button>
      {add.error && <span className="text-red-700 dark:text-red-300">{add.error instanceof ApiError ? add.error.message : "That place could not be added."}</span>}
    </div>
  );
}
