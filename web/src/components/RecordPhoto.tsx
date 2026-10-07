// A record's photo on its own page: ONE block for every record page (a
// machine, an asset, a record on a shelf), so the same picture behaves the
// same everywhere.
//
//   • The record's own picture, in the big box, to change or remove.
//   • With none of its own and one suggested (#3818), the suggestion IS in
//     the big box, marked Suggested, with one thing to do (Use this photo)
//     and one quiet way out (Not this one). It used to sit as a small tile
//     under an empty box holding a letter, so a picked suggestion looked like
//     it had gone nowhere (#4373).
//   • While one is being looked for it says so, and when none was found it
//     says that, with Search again: never a blank that comes and goes.
//   • One "Find a photo on the web", whose AI Pick is the scan inbox's, shown
//     only where AI can answer.

import { lazy, Suspense, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type ImageOption } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { markShownBeside, PICTURE_STATE_TEXT, usePhotoSuggestionFor } from "../lib/photoSuggestions";
import { EntityImageEdit } from "./EntityImageEdit";
// The web photo search loads when it is opened (#4945).
const ImageSearchPicker = lazy(() => import("./ImageSearchPicker").then((m) => ({ default: m.ImageSearchPicker })));
import { useAiStatus } from "./AiStatusNotice";

const KEEP_FAILED = "That picture couldn't be kept. Try another.";

/** The address of the copy on screen, when it is one the server can fetch. */
function shownAddress(shownUrl: string | undefined): string | undefined {
  if (!shownUrl) return undefined;
  try {
    const u = new URL(shownUrl);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** A picture picked from the results (by the person or by AI Pick), or
 *  pasted, becomes the record's main photo. The copy the person saw is sent
 *  along, so a site that refuses its original still leaves them the picture
 *  they chose; a refusal says why. The photo it replaces stays in the record's
 *  photos, and the toast's Undo puts it back (#4515). */
export type WebPick =
  | { url: string; shownUrl?: string; found?: { sourcePage?: string; searched?: string }; ai?: { reason: string; tile: number } }
  | { file: File };
export function usePictureFromWeb(opts: { kind: string; id: string; instance?: string | null; onSaved: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    opts.onSaved();
    void qc.invalidateQueries({ queryKey: ["image-options", activeSlug, opts.kind, opts.id] });
    void qc.invalidateQueries({ queryKey: ["file-attachments", activeSlug] });
  };
  return useMutation({
    mutationFn: async (pick: WebPick) => {
      const target = { entity_kind: opts.kind, entity_id: opts.id, instance: opts.instance ?? null };
      if ("file" in pick) {
        const stored = await api.uploadFile(activeSlug!, pick.file);
        return { r: await api.enrichEntityImage(activeSlug!, { ...target, file_id: stored.id }), pick };
      }
      const shown = shownAddress(pick.shownUrl);
      const r = await api.enrichEntityImage(activeSlug!, {
        ...target,
        image_url: pick.url,
        ...(shown && shown !== pick.url ? { shown_url: shown } : {}),
        source: pick.ai ? "ai_pick" : "web",
        ...(pick.found?.sourcePage ? { source_page: pick.found.sourcePage } : {}),
        ...(pick.found?.searched ? { searched: pick.found.searched } : {}),
        ...(pick.ai ? { reason: pick.ai.reason } : {}),
      });
      return { r, pick };
    },
    onSuccess: ({ r, pick }) => {
      if (!r.image_path) return void toast.error(r.reason ?? KEEP_FAILED);
      refresh();
      const previous = r.previous_image_path ?? null;
      const said = "ai" in pick && pick.ai ? `Photo set to tile ${pick.ai.tile}.` : "Photo set.";
      toast.action(previous ? `${said} The one it replaces is kept in its photos.` : said, {
        actionLabel: "Undo",
        duration: 10_000,
        onAction: async () => {
          try {
            await api.setMainPhoto(activeSlug!, { entity_kind: opts.kind, entity_id: opts.id, instance: opts.instance ?? null, image_path: previous });
            refresh();
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : "Couldn't put the old photo back. Try again.");
          }
        },
      });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : KEEP_FAILED),
  });
}

/** The answers to a suggested picture: use it, not this one, search again. */
export function useSuggestionAnswers(opts: { kind: string; id: string; onApplied: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const suggestion = usePhotoSuggestionFor(opts.id);
  // The kind the suggestion was saved under answers it, whatever the page
  // calls the record.
  const savedKind = suggestion?.entity_kind ?? opts.kind;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["photo-suggestions", activeSlug] });
  const use = useMutation({
    mutationFn: () => api.usePhotoSuggestion(activeSlug!, savedKind, opts.id),
    onSuccess: () => {
      refresh();
      opts.onApplied();
      toast.success("Photo added.");
    },
    onError: (e) => {
      refresh();
      toast.error(e instanceof ApiError ? e.message : "Couldn't add that photo.");
    },
  });
  const decline = useMutation({
    mutationFn: () => api.declinePhotoSuggestion(activeSlug!, savedKind, opts.id),
    onSuccess: () => {
      refresh();
      toast.info("No more suggestions for this one until its name changes.");
    },
    onError: () => toast.error("Couldn't save that. Try again."),
  });
  const search = useMutation({
    mutationFn: () => api.searchPhotoFor(activeSlug!, savedKind, opts.id),
    onSuccess: refresh,
    onError: (e) => {
      refresh();
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the search. Try again.");
    },
  });
  return { suggestion, savedKind, use, decline, search };
}

/** What a record with no picture of its own says about a suggestion: the two
 *  answers, that one is being looked for, or that none was found. */
export function SuggestionAnswer({ answers }: { answers: ReturnType<typeof useSuggestionAnswers> }) {
  const { suggestion, use, decline, search } = answers;
  if (!suggestion) return null;
  if (suggestion.status === "queued") {
    return (
      <p data-testid="suggested-photo-looking" className="flex items-center gap-1.5 text-xs text-muted dark:text-slate-400">
        <ImageIcon size={12} className="animate-pulse" /> {PICTURE_STATE_TEXT.looking}
      </p>
    );
  }
  if (suggestion.status === "none") {
    return (
      <p data-testid="suggested-photo-none" className="flex flex-wrap items-center gap-1.5 text-xs text-muted dark:text-slate-400">
        <ImageIcon size={12} /> No good photo found.
        <button
          type="button"
          onClick={() => search.mutate()}
          disabled={search.isPending}
          className="inline-flex min-h-9 items-center font-medium text-cobble-600 hover:text-cobble-700 dark:text-cobble-300 disabled:opacity-60"
        >
          Search again
        </button>
      </p>
    );
  }
  return (
    <div data-testid="suggested-photo" className="space-y-1.5">
      {suggestion.query && (
        <p className="break-words text-xs text-muted dark:text-slate-400">Found by searching “{suggestion.query}”.</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => use.mutate()}
          disabled={use.isPending}
          className="inline-flex min-h-9 items-center rounded-md bg-cobble-600 px-3 text-[13px] font-semibold text-white hover:bg-cobble-700 disabled:opacity-60"
        >
          Use this photo
        </button>
        <button
          type="button"
          onClick={() => decline.mutate()}
          disabled={decline.isPending}
          className="inline-flex min-h-9 items-center rounded-md px-3 text-[13px] text-muted hover:text-content dark:text-slate-400"
        >
          Not this one
        </button>
      </div>
    </div>
  );
}

/** "Find a photo on the web": the one picker, with the scan inbox's AI Pick
 *  where AI can answer. A tap uses a picture; AI Pick chooses one and uses
 *  it (#4515), or says there is no good one and changes nothing. */
export function WebPhotoSearch({
  kind,
  id,
  instance,
  brand,
  onSaved,
  startOpen = false,
}: {
  kind: string;
  id: string;
  instance?: string | null;
  brand?: string | null;
  /** The record changed: refetch what shows it. */
  onSaved: () => void;
  startOpen?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [open, setOpen] = useState(startOpen);
  const ai = useAiStatus();
  const fromWeb = usePictureFromWeb({ kind, id, instance, onSaved });
  // The AI's answer on screen at once, under the grid; after a reload the
  // server's remembered one says the same.
  const [best, setBest] = useState<{ url: string | null; reason: string } | null>(null);
  const rank = useMutation({
    mutationFn: async (candidates: ImageOption[]) => ({
      candidates,
      r: await api.rankRecordPhotoAi(activeSlug!, { entity_kind: kind, entity_id: id, candidates: candidates.slice(0, 24) }),
    }),
    onSuccess: ({ candidates, r }) => {
      const at = r.chosen_url ? candidates.findIndex((c) => c.url === r.chosen_url) : -1;
      const chosen = at >= 0 ? candidates[at]! : null;
      setBest({ url: chosen?.url ?? null, reason: r.reason });
      if (!chosen) return void toast.info(r.reason || "None of these is a good photo of it. Nothing was changed.");
      fromWeb.mutate({ url: chosen.url, shownUrl: chosen.thumb || undefined, found: { sourcePage: chosen.source }, ai: { reason: r.reason, tile: at + 1 } });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "The AI couldn't pick one. Try again, or choose one yourself."),
  });
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-9 items-center text-xs font-medium text-accent hover:underline"
      >
        {open ? "Hide the photo search" : "Find a photo on the web"}
      </button>
      {open && (
        <Suspense fallback={<div className="mt-1.5 h-24" aria-busy="true" />}>
        <div className="mt-1.5">
          {/* Derived mode: the server builds the phrase from this record's own
              name, maker and fields, the way the scan inbox does. It also
              remembers the last results, the photo in use and AI Pick's
              choice, so a reload shows them as they were. */}
          <ImageSearchPicker
            entity={{ kind, id }}
            brand={brand ?? undefined}
            busy={fromWeb.isPending}
            onPick={(url, shownUrl, found) => fromWeb.mutate({ url, shownUrl, found })}
            onPasteImage={(file) => fromWeb.mutate({ file })}
            onPickBest={ai?.available ? (c) => rank.mutate(c) : undefined}
            pickingBest={rank.isPending || (fromWeb.isPending && !!rank.data)}
            bestUrl={best?.url ?? undefined}
            bestReason={best?.reason ?? undefined}
          />
        </div>
        </Suspense>
      )}
    </div>
  );
}

export function RecordPhoto({
  kind,
  id,
  instance,
  src,
  alt,
  brand,
  size = 220,
  fit,
  suggestions = true,
  onChange,
  onAutoFetch,
  autoBusy,
  onSaved,
}: {
  /** The kind the record's suggestion and search are asked under. */
  kind: string;
  id: string;
  instance?: string | null;
  /** The record's own picture. */
  src: string | null | undefined;
  alt: string;
  brand?: string | null;
  size?: number;
  fit?: "cover" | "contain";
  suggestions?: boolean;
  /** The page's own write of the record's picture (an upload, a Remove). */
  onChange: (imagePath: string | null) => void;
  onAutoFetch?: () => void;
  autoBusy?: boolean;
  /** The record changed: refetch what shows it. */
  onSaved: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const answers = useSuggestionAnswers({ kind, id, onApplied: onSaved });
  // This page shows the offer: the universal panel on it stays quiet.
  useEffect(() => markShownBeside(id), [id]);
  const s = suggestions ? answers.suggestion : null;
  const suggestedSrc = !src && s?.status === "suggested" ? s.image_path : null;
  return (
    <div data-testid="record-photo" className="space-y-2">
      <EntityImageEdit
        slug={activeSlug!}
        src={src || suggestedSrc}
        suggested={!!suggestedSrc}
        alt={alt}
        size={size}
        fit={fit}
        onChange={onChange}
        onAutoFetch={onAutoFetch}
        autoBusy={autoBusy}
      />
      {suggestions && !src && <SuggestionAnswer answers={answers} />}
      <WebPhotoSearch kind={kind} id={id} instance={instance} brand={brand} onSaved={onSaved} />
    </div>
  );
}
