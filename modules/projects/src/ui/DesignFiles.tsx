// Files on a design — the pattern PDF the extraction stored, photos of the
// finished/target make, anything else attached to (projects, project, id).
// Images render as authed thumbnails; other files (the pattern) as chips.
// Upload accepts images + PDFs: a PDF lands as role=pattern, an image as
// role=gallery. Mirrors inventory's PartGallery, slimmed (no cover logic).
//
// A pattern PDF pulls its own photo: the server extracts the images the
// moment the pattern is attached and attaches the best photograph. What the
// panel adds is the STRIP - the other images the pattern holds, revealed by a
// button that only exists when there is a choice to make, and a tile tap
// swaps the photo. Same idiom as "find a better catalog photo" on a scan card.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Images, Trash2, Upload } from "lucide-react";
import { canPreviewFile, FilePreview, Lightbox, Modal, SelectableTile, usePasteImage, openAuthedFile, useConfirm, useFilePreviewRegistry, useToast, EntityPhoto, noteWorkspaceWrite, uploadJson } from "@cobblr/platform-web";
import { useProjects } from "./context";
import type { PatternPhotoState } from "./api";
import { patternNeedsKey } from "./PatternNeeds";

interface AttachmentRow {
  id: string;
  file_id: string;
  filename: string;
  mime_type: string;
  kind: string;
  role: string | null;
}

/** A strip is worth revealing when it offers a CHOICE: more than one image,
 *  or a single image the pull did not attach (below the floor) - a single
 *  image already in use would be a button that does nothing. */
export function stripOffersChoice(s: PatternPhotoState | undefined): boolean {
  if (!s || s.status !== "ready") return false;
  if (s.candidates.length > 1) return true;
  return s.candidates.length === 1 && s.used_index === null;
}

export function DesignFiles({ designId }: { designId: string }) {
  const { orgSlug, getToken, api } = useProjects();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  // A picture pasted on the design files is added like one chosen (usePasteImage).
  usePasteImage(() => fileInput.current?.parentElement ?? null, { onFiles: ([f]) => f && upload.mutate(f), accept: "image/*,application/pdf" });
  const [stripOpen, setStripOpen] = useState(false);
  // The pattern opens IN the app (every page, zoom, keep the screen on),
  // with a new tab one tap away; a format with no viewer opens in a tab.
  const [reading, setReading] = useState<AttachmentRow | null>(null);
  // The design photo open in the shared viewer, which steps through them all.
  const [viewing, setViewing] = useState<number | null>(null);
  useFilePreviewRegistry();

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  const base = `/api/v1/orgs/${orgSlug}/modules/core-files`;
  const filesKey = ["design-files", orgSlug, designId];
  const patternKey = ["design-pattern-photo", orgSlug, designId];

  const list = useQuery({
    queryKey: filesKey,
    queryFn: async () => {
      const res = await fetch(
        `${base}/attachments?source_module=projects&source_type=project&source_id=${encodeURIComponent(designId)}`,
        { headers: auth() },
      );
      if (!res.ok) throw await refusal(res, "Couldn't take that file off");
      return ((await res.json()) as { items: AttachmentRow[] }).items;
    },
    enabled: !!orgSlug,
  });

  const items = list.data ?? [];
  const images = items.filter((a) => a.kind === "image" || a.mime_type.startsWith("image/"));
  const files = items.filter((a) => !(a.kind === "image" || a.mime_type.startsWith("image/")));
  const hasPattern = files.some((a) => a.role === "pattern" || a.mime_type === "application/pdf");

  // The pull's result. Polls while a pull is running (a fresh upload, or a
  // design that had its pattern before pulls were automatic), then settles.
  const pattern = useQuery({
    queryKey: patternKey,
    queryFn: () => api.patternPhoto(designId),
    enabled: !!orgSlug && hasPattern,
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 1500 : false),
  });
  // When the pull lands its photo, the photo grid is stale: refresh it once.
  const landed = pattern.data?.status === "ready" ? pattern.data.photo_file_id : null;
  useEffect(() => {
    if (landed) void qc.invalidateQueries({ queryKey: filesKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landed]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const f = await uploadJson<{ id: string }>(`${base}/files`, fd, { token: getToken(), file });
      const role = file.type === "application/pdf" ? "pattern" : "gallery";
      const ares = await fetch(`${base}/attachments`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: f.id,
          source_module: "projects",
          source_type: "project",
          source_id: designId,
          role,
        }),
      });
      if (!ares.ok) throw await refusal(ares, "Couldn't attach that file");
      noteWorkspaceWrite(`${base}/attachments`);
      return role;
    },
    onSuccess: (role) => {
      void qc.invalidateQueries({ queryKey: filesKey });
      if (role === "pattern") {
        // The pull starts server-side on attach; the state read picks it up
        // as pending and the poll above carries it to ready.
        void qc.invalidateQueries({ queryKey: patternKey });
        void qc.invalidateQueries({ queryKey: patternNeedsKey(designId) });
        toast.info("Reading the pattern for its photo, yarn and hooks…");
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const detach = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/attachments/${id}`, { method: "DELETE", headers: auth() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      noteWorkspaceWrite(`${base}/attachments/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: filesKey });
      void qc.invalidateQueries({ queryKey: patternKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const usePhoto = useMutation({
    mutationFn: (index: number) => api.usePatternPhoto(designId, index),
    onSuccess: (r) => {
      if (r.ok && r.file) {
        toast.success(`Using the ${r.file.width}×${r.file.height} image as the photo.`);
        void qc.invalidateQueries({ queryKey: filesKey });
        void qc.invalidateQueries({ queryKey: patternKey });
      } else {
        toast.info(r.reason ?? "Couldn't use that image.");
      }
    },
    onError: (e) => toast.error(`Couldn't use that image: ${(e as Error).message}`),
  });

  // A pull that failed says why and offers the explicit re-run (#5475); it
  // used to read as "reading the pattern" forever, or as nothing at all.
  const retryPull = useMutation({
    mutationFn: () => api.extractPatternImages(designId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: patternKey });
      void qc.invalidateQueries({ queryKey: filesKey });
    },
    onError: (e) => toast.error(`Couldn't read the pattern again: ${(e as Error).message}`),
  });

  const state = pattern.data;
  const offersChoice = stripOffersChoice(state);
  const pullFailed = state?.status === "ready" && !!state.error;
  const belowFloor = state?.status === "ready" && state.extracted > 0 && state.hero_index === null && state.used_index === null;

  return (
    <div
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5"
      data-testid="design-files-panel"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // pattern &amp; photos
        </div>
        <div className="flex items-center gap-3">
          {hasPattern && state?.status === "pending" && (
            <span className="text-xs text-faint dark:text-slate-500" data-testid="pattern-photo-pending">
              reading the pattern…
            </span>
          )}
          {offersChoice && state && (
            <button
              type="button"
              onClick={() => setStripOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-content dark:hover:text-mortar-100 transition"
              title="The other images inside the pattern PDF; tap one to use it as the photo"
              aria-expanded={stripOpen}
              data-testid="pattern-photo-strip-toggle"
            >
              <Images size={13} /> {stripOpen ? "hide" : "other images in the pattern"} ({state.candidates.length})
            </button>
          )}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-content dark:hover:text-mortar-100 transition"
          >
            <Upload size={13} /> add
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
      </div>
      {items.length === 0 && !list.isLoading && (
        <p className="text-xs text-faint dark:text-slate-500 italic">
          No pattern or photos yet - upload the pattern PDF or a photo of the make.
        </p>
      )}
      {pullFailed && state && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted dark:text-slate-400" data-testid="pattern-photo-failed">
          <span>Couldn't take a photo from the pattern ({state.error}).</span>
          <button
            type="button"
            onClick={() => retryPull.mutate()}
            disabled={retryPull.isPending}
            className="text-accent underline underline-offset-2 hover:text-content disabled:opacity-50 dark:hover:text-mortar-100"
          >
            {retryPull.isPending ? "Trying again…" : "Try again"}
          </button>
        </div>
      )}
      {belowFloor && !stripOpen && (
        <p className="text-xs text-faint dark:text-slate-500 italic mb-3" data-testid="pattern-photo-below-floor">
          None of the images in the pattern looks like a photograph, so nothing was attached. Open the strip to pick one.
        </p>
      )}
      {stripOpen && state && state.status === "ready" && (
        <CandidateStrip
          designId={designId}
          state={state}
          busy={usePhoto.isPending}
          onUse={(i) => usePhoto.mutate(i)}
          thumbUrl={(i) => api.patternPhotoThumbUrl(designId, i)}
        />
      )}
      {files.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {files.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <FileText size={15} className="text-accent shrink-0" />
              {/* Opened with the token: a plain link to /raw carries none and
                  401s, so the pattern never opened (#3753). */}
              <button
                type="button"
                onClick={() =>
                  canPreviewFile(a.filename)
                    ? setReading(a)
                    : void openAuthedFile(`${base}/files/${a.file_id}/raw`, { getToken, mime: a.mime_type, filename: a.filename })
                }
                className="text-left text-content dark:text-mortar-100 hover:text-accent truncate"
              >
                {a.filename}
              </button>
              {a.role === "pattern" && (
                <span className="shrink-0 text-[9px] font-mono uppercase tracking-widest border border-cobble-300 dark:border-cobble-700 text-accent rounded px-1.5 py-0.5">
                  pattern
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  void confirm({
                    title: "Remove this file?",
                    message: `${a.filename} will be detached from the design.`,
                    confirmLabel: "Remove",
                  }).then((ok) => ok && detach.mutate(a.id));
                }}
                className="ml-auto text-faint hover:text-ember-500 shrink-0"
                title="Remove"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {images.map((a, i) => (
            <DesignThumb
              key={a.id}
              thumb={`${base}/files/${a.file_id}/raw?variant=thumb`}
              alt={a.filename}
              fromPattern={a.role === "photo" && a.file_id === state?.photo_file_id}
              onOpen={() => setViewing(i)}
            />
          ))}
        </div>
      )}
      {viewing !== null && images[viewing] && (
        <Lightbox
          items={images.map((a) => ({
            key: a.id,
            caption: a.filename,
            src: `${base}/files/${a.file_id}/raw?variant=medium`,
            original: `${base}/files/${a.file_id}/raw`,
            thumb: `${base}/files/${a.file_id}/raw?variant=thumb`,
          }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
      {reading && (
        <Modal open onClose={() => setReading(null)} title={reading.filename} size="lg" fillHeight>
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={() => void openAuthedFile(`${base}/files/${reading.file_id}/raw`, { getToken, mime: reading.mime_type, filename: reading.filename })}
              className="text-xs text-muted hover:text-accent underline decoration-dotted underline-offset-2"
            >
              Open in a new tab
            </button>
          </div>
          <FilePreview src={`${base}/files/${reading.file_id}/raw`} filename={reading.filename} />
        </Modal>
      )}
    </div>
  );
}

/** The other images the pattern holds. The one in use is ringed; images that
 *  failed the photograph floor (charts, logos, drawings) are dimmed but still
 *  offered - the floor is a default, not a rule about what you may pick. */
function CandidateStrip({
  designId,
  state,
  busy,
  onUse,
  thumbUrl,
}: {
  designId: string;
  state: PatternPhotoState;
  busy: boolean;
  onUse: (index: number) => void;
  thumbUrl: (index: number) => string;
}) {
  return (
    <div className="mb-3" data-testid="pattern-photo-strip">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
        {state.candidates.length} image{state.candidates.length === 1 ? "" : "s"} in the pattern - tap one to use it as the photo
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {state.candidates.map((c) => (
          <CandidateTile
            key={`${designId}-${c.index}`}
            src={thumbUrl(c.index)}
            inUse={c.index === state.used_index}
            photo={c.photo}
            label={`${c.width}×${c.height}, page ${c.page}`}
            disabled={busy || c.index === state.used_index}
            onClick={() => onUse(c.index)}
          />
        ))}
      </div>
    </div>
  );
}

function CandidateTile({
  src,
  inUse,
  photo,
  label,
  disabled,
  onClick,
}: {
  src: string;
  inUse: boolean;
  photo: boolean;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  // The one in use is outlined the way every chosen tile is (SelectableTile);
  // a picture that failed the photograph floor is dimmed, still offered.
  return (
    <SelectableTile
      data-testid="pattern-photo-candidate"
      selected={inUse}
      selectedLabel="In use"
      onClick={onClick}
      disabled={disabled}
      title={photo ? `Use this photo - ${label}` : `Looks like a diagram - ${label}`}
      className={`w-20 h-20 ${photo ? "" : "opacity-60 hover:opacity-100"}`}
      faceClassName="bg-subtle dark:bg-slate-800"
    >
      <EntityPhoto src={src} alt={label} fill placeholder={null} />
    </SelectableTile>
  );
}

/** A design photo's tile; a tap opens the shared viewer over all of them. */
function DesignThumb({ thumb, alt, fromPattern, onOpen }: { thumb: string; alt: string; fromPattern?: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${alt}`}
      title={fromPattern ? `${alt} (pulled from the pattern)` : alt}
      className="relative block w-full cursor-zoom-in"
      data-testid={fromPattern ? "design-photo-from-pattern" : undefined}
    >
      <EntityPhoto src={thumb} alt={alt} aspect="square" placeholder={null} className="rounded-md border border-line dark:border-slate-700 hover:border-accent transition">
        {fromPattern && (
          <span className="absolute bottom-1 left-1 bg-surface/90 dark:bg-slate-900/90 text-accent text-[9px] font-mono uppercase tracking-widest rounded px-1 py-0.5">
            from pattern
          </span>
        )}
      </EntityPhoto>
    </button>
  );
}

/** The server's own reason for refusing, else what was being tried. */
async function refusal(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  const why = body?.message ?? body?.error;
  return new Error(why ? `${what}: ${why}` : `${what} (${res.status}).`);
}
