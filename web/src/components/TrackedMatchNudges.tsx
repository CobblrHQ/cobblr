// The two things worth saying while a scan and the record it matched are both
// in view, on ONE wrapping row: the scan recognised a KIND (Tea) but the record
// is filed somewhere else (Inventory); the record has no picture and the scan
// just found one. Each is one tap here and a hunt later. The rules are pure
// (lib/trackedMatchNudges.ts); this is their one rendering, shared by the
// expanded banner and the inbox card's condensed line so both say the same.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ImagePlus } from "lucide-react";
import { MoveToInstanceModal, useToast } from "@cobblr/platform-web";
import { api, ApiError, getToken, type ScanInboxItem, type TrackedMatch } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { listMismatch, pictureOffer } from "../lib/trackedMatchNudges";

const amberPill =
  "inline-flex items-center gap-1 rounded-full border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 px-2.5 py-1 text-xs font-medium disabled:opacity-50";

export function TrackedMatchNudges({ item, match }: { item: ScanInboxItem; match: TrackedMatch }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const menu = useQuery({
    queryKey: ["scan-menu", activeSlug],
    queryFn: () => api.scanMenu(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const [moveOpen, setMoveOpen] = useState(false);
  const givePicture = useMutation({
    mutationFn: (offer: { file_id?: string; image_url?: string }) =>
      api.enrichEntityImage(activeSlug, {
        entity_kind: match.kind,
        entity_id: match.id,
        instance: match.instance ?? null,
        ...offer,
      }),
    onSuccess: (r) => {
      if (r.image_path) toast.success(`Picture set on ${match.title}`);
      else toast.error(`Couldn't set the picture on ${match.title}`);
      void qc.invalidateQueries({ queryKey: ["scan-tracked", activeSlug] });
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const mismatch = listMismatch(item.suggested_candidates?.[0], match, menu.data?.items ?? []);
  const picture = pictureOffer(item, match);
  if (!mismatch && !picture) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" onClick={(e) => e.stopPropagation()}>
      {mismatch && (
        <>
          <span className="text-amber-800 dark:text-amber-200">
            Filed in <span className="font-medium">{mismatch.fromLabel}</span>, this scan says{" "}
            <span className="font-medium">{mismatch.toLabel}</span>
          </span>
          <button type="button" onClick={() => setMoveOpen(true)} className={amberPill}>
            <ArrowRightLeft size={12} /> Move it to {mismatch.toLabel}
          </button>
        </>
      )}
      {mismatch && picture && <span className="text-faint">·</span>}
      {picture && (
        <>
          <span className="text-amber-800 dark:text-amber-200">No picture yet</span>
          <button
            type="button"
            disabled={givePicture.isPending}
            onClick={() => givePicture.mutate(picture)}
            className={amberPill}
          >
            <ImagePlus size={12} /> {givePicture.isPending ? "Setting…" : "Use this scan's"}
          </button>
        </>
      )}
      {mismatch && (
        <MoveToInstanceModal
          open={moveOpen}
          onClose={() => setMoveOpen(false)}
          slug={activeSlug}
          getToken={getToken}
          moduleName={mismatch.module}
          fromInstance={mismatch.fromInstance}
          ids={[match.id]}
          noun={match.noun}
          defaultTo={mismatch.toInstance}
          onMoved={(_n, where) => {
            toast.success(`Moved ${match.title} to ${where}`);
            void qc.invalidateQueries({ queryKey: ["scan-tracked", activeSlug] });
            void qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}
