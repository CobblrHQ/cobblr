// "Suggested photo" on a record page (#3818): the picture the platform found
// for a record made without one, and the three answers. Use it puts it on
// the record; Show others opens the web picker on the same search; No thanks
// is remembered until the record's name changes. While the picture is looked
// for the page says so; when none was found it says that, with Search to look
// once more. Nothing shows once the record has a picture of its own.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon } from "lucide-react";
import { EntityPhoto, useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { markShownBeside, PICTURE_STATE_TEXT, usePhotoSuggestionFor } from "../lib/photoSuggestions";
import { ImageSearchPicker } from "./ImageSearchPicker";

export function SuggestedPhoto({
  kind,
  id,
  hasPicture,
  brand,
  onApplied,
  onPickOther,
  pickBusy,
  instance,
  besidePicture = true,
}: {
  kind: string;
  id: string;
  /** The record has a picture of its own: say nothing. */
  hasPicture: boolean;
  brand?: string | null;
  /** The record changed: refetch it. */
  onApplied: () => void;
  /** A picture chosen under Show others, saved the page's own way. Without
   *  one, it is saved the platform's way for any record. */
  onPickOther?: (url: string) => void;
  pickBusy?: boolean;
  /** The instance the record lives in, for the platform's own save. */
  instance?: string | null;
  /** Placed by the page beside the record's own picture. The universal
   *  panel passes false. */
  besidePicture?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const suggestion = usePhotoSuggestionFor(id);
  // The kind the suggestion was saved under answers it, whatever the page
  // calls the record.
  const savedKind = suggestion?.entity_kind ?? kind;
  // Beside the record's picture, this is the offer: the universal panel on the
  // same page stays quiet (photoSuggestions.ts).
  useEffect(() => (besidePicture ? markShownBeside(id) : undefined), [besidePicture, id]);
  const [others, setOthers] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["photo-suggestions", activeSlug] });
  const use = useMutation({
    mutationFn: () => api.usePhotoSuggestion(activeSlug!, savedKind, id),
    onSuccess: () => {
      refresh();
      onApplied();
      toast.success("Photo added.");
    },
    onError: (e) => {
      refresh();
      toast.error(e instanceof ApiError ? e.message : "Couldn't add that photo.");
    },
  });
  const decline = useMutation({
    mutationFn: () => api.declinePhotoSuggestion(activeSlug!, savedKind, id),
    onSuccess: () => {
      refresh();
      toast.info("No photo suggestions for this one until its name changes.");
    },
    onError: () => toast.error("Couldn't save that. Try again."),
  });

  const search = useMutation({
    mutationFn: () => api.searchPhotoFor(activeSlug!, savedKind, id),
    onSuccess: refresh,
    onError: (e) => {
      refresh();
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the search. Try again.");
    },
  });

  const pickOther = useMutation({
    mutationFn: (url: string) =>
      api.enrichEntityImage(activeSlug!, {
        entity_kind: savedKind,
        entity_id: id,
        instance: instance ?? (savedKind.endsWith(":item") ? savedKind.split(":")[0] ?? null : null),
        image_url: url,
      }),
    onSuccess: (r) => {
      if (!r.image_path) return void toast.error("Couldn't save that image.");
      refresh();
      onApplied();
      toast.success("Photo added.");
    },
    onError: () => toast.error("Couldn't save that image."),
  });

  if (hasPicture || !suggestion) return null;
  if (suggestion.status === "queued") {
    return (
      <p data-testid="suggested-photo-looking" className="text-xs text-muted dark:text-slate-400 flex items-center gap-1.5">
        <ImageIcon size={12} className="animate-pulse" /> {PICTURE_STATE_TEXT.looking}
      </p>
    );
  }
  if (suggestion.status === "none") {
    return (
      <p data-testid="suggested-photo-none" className="text-xs text-muted dark:text-slate-400 flex items-center gap-1.5">
        <ImageIcon size={12} /> {PICTURE_STATE_TEXT.not_found} ·
        <button
          type="button"
          onClick={() => search.mutate()}
          disabled={search.isPending}
          className="inline-flex min-h-9 items-center font-medium text-cobble-600 hover:text-cobble-700 dark:text-cobble-300 disabled:opacity-60"
        >
          Search
        </button>
      </p>
    );
  }
  return (
    <div data-testid="suggested-photo" className="rounded-lg border border-dashed border-accent/60 bg-cobble-50/50 dark:bg-cobble-900/20 p-2.5 space-y-2">
      <div className="flex items-start gap-2.5">
        <EntityPhoto src={suggestion.image_path} alt="Suggested photo" size={72} className="rounded shrink-0" />
        <div className="min-w-0 text-sm">
          <div className="font-medium text-content dark:text-mortar-100">Suggested photo</div>
          {suggestion.query && (
            <div className="text-xs text-muted dark:text-slate-400 truncate">Found by searching “{suggestion.query}”</div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => use.mutate()}
          disabled={use.isPending}
          className="inline-flex min-h-9 items-center rounded-md bg-cobble-600 px-3 text-[13px] font-semibold text-white hover:bg-cobble-700 disabled:opacity-60"
        >
          Use it
        </button>
        <button
          type="button"
          onClick={() => setOthers((v) => !v)}
          className="inline-flex min-h-9 items-center rounded-md border border-line dark:border-slate-600 px-3 text-[13px] text-content dark:text-mortar-100"
        >
          {others ? "Hide others" : "Show others"}
        </button>
        <button
          type="button"
          onClick={() => decline.mutate()}
          disabled={decline.isPending}
          className="inline-flex min-h-9 items-center rounded-md px-3 text-[13px] text-muted hover:text-content dark:text-slate-400"
        >
          No thanks
        </button>
      </div>
      {others && (
        <ImageSearchPicker
          entity={{ kind: savedKind, id }}
          brand={brand ?? undefined}
          busy={pickBusy ?? pickOther.isPending}
          onPick={(url) => (onPickOther ? onPickOther(url) : pickOther.mutate(url))}
          label="pick a photo"
        />
      )}
    </div>
  );
}
