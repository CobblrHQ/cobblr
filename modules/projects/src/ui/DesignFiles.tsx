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
import { useConfirm, useImageSrc, useToast } from "@cobblr/platform-web";
import { useProjects } from "./context";
import type { PatternPhotoState } from "./api";

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
  const [stripOpen, setStripOpen] = useState(false);

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      const ures = await fetch(`${base}/files`, { method: "POST", headers: auth(), body: fd });
      if (!ures.ok) throw new Error(`upload ${ures.status}`);
      const f = (await ures.json()) as { id: string };
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
      if (!ares.ok) throw new Error(`attach ${ares.status}`);
      return role;
    },
    onSuccess: (role) => {
      void qc.invalidateQueries({ queryKey: filesKey });
      if (role === "pattern") {
        // The pull starts server-side on attach; the state read picks it up
        // as pending and the poll above carries it to ready.
        void qc.invalidateQueries({ queryKey: patternKey });
        toast.info("Reading the pattern for its photo…");
      }
    },
  });

  const detach = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/attachments/${id}`, { method: "DELETE", headers: auth() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: filesKey });
      void qc.invalidateQueries({ queryKey: patternKey });
    },
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

  const state = pattern.data;
  const offersChoice = stripOffersChoice(state);
  const belowFloor = state?.status === "ready" && state.extracted > 0 && state.hero_index === null && state.used_index === null;

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
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
              <a
                href={`${base}/files/${a.file_id}/raw`}
                target="_blank"
                rel="noreferrer"
                className="text-content dark:text-mortar-100 hover:text-accent truncate"
              >
                {a.filename}
              </a>
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
          {images.map((a) => (
            <DesignThumb
              key={a.id}
              thumb={`${base}/files/${a.file_id}/raw?variant=thumb`}
              full={`${base}/files/${a.file_id}/raw`}
              alt={a.filename}
              fromPattern={a.role === "photo" && a.file_id === state?.photo_file_id}
            />
          ))}
        </div>
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
  const resolved = useImageSrc(src);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={inUse ? `In use - ${label}` : photo ? `Use this photo - ${label}` : `Looks like a diagram - ${label}`}
      data-testid="pattern-photo-candidate"
      data-in-use={inUse ? "1" : undefined}
      data-photo={photo ? "1" : "0"}
      className={`relative shrink-0 w-20 h-20 rounded-md border overflow-hidden transition ${
        inUse
          ? "border-accent ring-2 ring-accent/40"
          : "border-line dark:border-slate-700 hover:border-accent"
      } ${photo ? "" : "opacity-60 hover:opacity-100"} disabled:cursor-default`}
    >
      {resolved ? (
        <img src={resolved} alt={label} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-subtle dark:bg-slate-800 animate-pulse" />
      )}
      {inUse && (
        <span className="absolute bottom-0 inset-x-0 bg-accent text-white text-[9px] font-mono uppercase tracking-widest text-center py-0.5">
          in use
        </span>
      )}
    </button>
  );
}

/** Authed thumbnail — a bare <img> can't send the Bearer token. */
function DesignThumb({ thumb, full, alt, fromPattern }: { thumb: string; full: string; alt: string; fromPattern?: boolean }) {
  const resolved = useImageSrc(thumb);
  const resolvedFull = useImageSrc(full);
  if (!resolved) {
    return <div className="aspect-square rounded-md bg-subtle dark:bg-slate-800 animate-pulse" />;
  }
  return (
    <a
      href={resolvedFull ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={fromPattern ? `${alt} (pulled from the pattern)` : alt}
      className="relative block"
      data-testid={fromPattern ? "design-photo-from-pattern" : undefined}
    >
      <img
        src={resolved}
        alt={alt}
        className="aspect-square w-full object-cover rounded-md border border-line dark:border-slate-700 hover:border-accent transition"
      />
      {fromPattern && (
        <span className="absolute bottom-1 left-1 bg-surface/90 dark:bg-slate-900/90 text-accent text-[9px] font-mono uppercase tracking-widest rounded px-1 py-0.5">
          from pattern
        </span>
      )}
    </a>
  );
}
