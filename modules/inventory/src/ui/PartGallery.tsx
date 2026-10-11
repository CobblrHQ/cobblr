// Part-page photo gallery. Lists every core-files attachment with
// role='gallery' for (inventory, part, id) plus a drop zone for new
// uploads. The first image doubles as the cover unless image_path is
// explicitly set.
//
// Self-contained (no extra shared component needed) — it reaches
// core-files directly via the inventory module's orgSlug + getToken.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Scissors, Star, Trash2, Upload, X } from "lucide-react";
import { SELECTED_TILE, useConfirm, useImageSrc, usePhotoPick, useToast, EntityPhoto, Lightbox, MutationError, noteWorkspaceWrite, uploadJson, workspaceFetch } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { cutoutPlainBackground } from "./remove-background";
import { isCoverFile } from "./gallery-cover";

interface AttachmentRow {
  id: string;
  file_id: string;
  filename: string;
  mime_type: string;
  kind: string;
  role: string | null;
  primary: boolean;
}

interface Props {
  partId: string;
  /** Current cover image path on the part — to mark "current cover" in the UI. */
  coverImagePath: string | null;
  /** Setter when the user clicks "Set as cover". */
  onSetCover: (imagePath: string) => void;
}

export function PartGallery({ partId, coverImagePath, onSetCover }: Props) {
  const { orgSlug, getToken, itemNoun } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [dragOver, setDragOver] = useState(false);
  // The photo open in the shared viewer, which steps through all of them.
  const [viewing, setViewing] = useState<number | null>(null);

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  const base = `/api/v1/orgs/${orgSlug}/modules/core-files`;

  const list = useQuery({
    queryKey: ["part-gallery", orgSlug, partId],
    queryFn: async () => {
      const res = await workspaceFetch(
        `${base}/attachments?source_module=inventory&source_type=part&source_id=${encodeURIComponent(partId)}`,
        { headers: auth() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: AttachmentRow[] };
      return data.items.filter((a) => a.kind === "image");
    },
    enabled: !!orgSlug,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const f = await uploadJson<{ id: string }>(`${base}/files`, fd, { token: getToken(), file });
      const ares = await workspaceFetch(`${base}/attachments`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: f.id,
          source_module: "inventory",
          source_type: "part",
          source_id: partId,
          role: "gallery",
        }),
      });
      if (!ares.ok) throw new Error(`attach ${ares.status}`);
      noteWorkspaceWrite(`${base}/attachments`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["part-gallery", orgSlug, partId] });
    },
    onError: (e) => toast.error(`Upload failed: ${(e as Error).message}`),
  });

  const detach = useMutation({
    mutationFn: async (id: string) => {
      const res = await workspaceFetch(`${base}/attachments/${id}`, {
        method: "DELETE",
        headers: auth(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      noteWorkspaceWrite(`${base}/attachments/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["part-gallery", orgSlug, partId] });
    },
  });

  // Background removal — fetch the photo, knock out a plain background
  // (zero-dep canvas chroma key), upload the transparent PNG as a new gallery
  // photo, and make it the cover. Great for garment/product shots on white.
  const [cutting, setCutting] = useState<string | null>(null);
  async function handleCutout(att: AttachmentRow) {
    setCutting(att.id);
    try {
      const r = await workspaceFetch(fullUrl(att.file_id), { headers: auth() });
      const blob = await r.blob();
      const out = await cutoutPlainBackground(blob);
      if (!out) {
        toast.error("No plain background to cut out - works best on a photo over a plain backdrop.");
        return;
      }
      const fd = new FormData();
      fd.append("file", new File([out], (att.filename.replace(/\.\w+$/, "") || "cutout") + "-cutout.png", { type: "image/png" }));
      const f = await uploadJson<{ id: string }>(`${base}/files`, fd, { token: getToken() });
      const ares = await workspaceFetch(`${base}/attachments`, {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: f.id, source_module: "inventory", source_type: "part", source_id: partId, role: "gallery" }),
      });
      if (!ares.ok) throw new Error(`attach ${ares.status}`);
      noteWorkspaceWrite(`${base}/attachments`);
      onSetCover(fullUrl(f.id));
      toast.success("Background removed - cut-out set as the cover.");
      void qc.invalidateQueries({ queryKey: ["part-gallery", orgSlug, partId] });
    } catch (e) {
      toast.error(`Cut-out failed: ${(e as Error).message}`);
    } finally {
      setCutting(null);
    }
  }

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        await upload.mutateAsync(f);
      } catch {
        /* toast already fired */
      }
    }
  }
  const photo = usePhotoPick((files) => void handleFiles(files), { multiple: true, title: "Photo of this item", label: "Choose photos" });

  function thumbUrl(fileId: string): string {
    return `${base}/files/${fileId}/raw?variant=thumb`;
  }
  function fullUrl(fileId: string): string {
    return `${base}/files/${fileId}/raw`;
  }

  const items = list.data ?? [];

  return (
    <section
      className={
        "rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 transition " +
        (dragOver
          ? "outline-dashed outline-1 outline-offset-4 outline-cobble-400"
          : "")
      }
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 flex items-center gap-2">
          <Camera size={11} /> Photos
          {dragOver && (
            <span className="text-accent normal-case tracking-normal font-normal">
              drop to upload
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={photo.pick}
          className="text-[11px] font-mono uppercase tracking-widest text-muted hover:text-accent inline-flex items-center gap-1"
        >
          <Upload size={11} /> {upload.isPending ? "uploading…" : "add"}
        </button>
        {photo.input}
      </div>
      {list.isLoading && (
        <div className="text-xs text-faint">loading…</div>
      )}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-faint italic border border-dashed border-line dark:border-slate-700 rounded-lg p-6 text-center">
          No photos yet. Drag-and-drop or click "add" above.
        </div>
      )}
      {/* Two across on a phone, not three: the row under each photo holds
          three labelled actions, and at 390px a third of the width is 97px,
          ten short of what "cover", "cut out" and the bin need on one line. */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {items.map((att, i) => {
            const isCover = isCoverFile(coverImagePath, att.file_id);
            return (
              <div
                key={att.id}
                className={
                  "group rounded-md overflow-hidden border border-line dark:border-slate-700 flex flex-col " +
                  // The cover is the chosen one: the same outline every chosen tile has.
                  (isCover ? SELECTED_TILE : "")
                }
              >
                <div className="relative">
                  <GalleryImg thumb={thumbUrl(att.file_id)} alt={att.filename} onOpen={() => setViewing(i)} />
                  {isCover && (
                    <div className="absolute top-1 left-1 text-[9px] font-mono uppercase tracking-widest bg-cobble-600 text-white rounded px-1.5 py-0.5">
                      cover
                    </div>
                  )}
                </div>
                {/* The tile's actions sit UNDER the photo, always shown, never
                    over it. Over it they were hover-only (unreachable on a
                    tablet, #3239), then a scrim across the photo's bottom edge,
                    which is where a product prints its own words: white
                    "cut out" over a white "4KG PLA BLACK" (#3325). A scrim dark
                    enough for that blackens every photo's bottom on every touch
                    screen; a row of its own depends on nothing in the photo. */}
                <div className="flex items-center gap-1 px-1 py-1 border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 text-[10px] leading-none text-muted dark:text-slate-400 whitespace-nowrap">
                  {!isCover && (
                    <button
                      type="button"
                      onClick={() => onSetCover(fullUrl(att.file_id))}
                      className="inline-flex items-center gap-0.5 hover:text-accent dark:hover:text-cobble-300"
                      title="Set as cover"
                    >
                      <Star size={10} /> cover
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCutout(att)}
                    disabled={cutting === att.id}
                    className="inline-flex items-center gap-0.5 hover:text-accent dark:hover:text-cobble-300 disabled:opacity-60"
                    title="Remove background (cut out the item)"
                  >
                    <Scissors size={10} className={cutting === att.id ? "animate-pulse" : ""} />
                    {cutting === att.id ? "…" : "cut out"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Remove photo?",
                        message: `The file stays in your library; only the attachment to this ${itemNoun} is removed.`,
                        confirmLabel: "Remove",
                        destructive: true,
                      });
                      if (ok) detach.mutate(att.id);
                    }}
                    className="inline-flex items-center gap-0.5 ml-auto hover:text-red-600 dark:hover:text-red-400"
                    title="Remove"
                    aria-label="Remove photo"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {viewing !== null && items[viewing] && (
        <Lightbox
          items={items.map((att) => ({
            key: att.id,
            caption: att.filename,
            src: `${base}/files/${att.file_id}/raw?variant=medium`,
            original: fullUrl(att.file_id),
            thumb: thumbUrl(att.file_id),
          }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
      <MutationError mutation={detach} className="block mt-2" />
      {/* Surface a tiny X if uploading mid-drag so the user can cancel/reset if needed. */}
      {upload.isPending && (
        <div className="text-[10px] font-mono text-accent mt-2 inline-flex items-center gap-1">
          <Upload size={10} className="animate-pulse" /> uploading
          <button type="button" onClick={() => upload.reset()} title="Reset state">
            <X size={10} />
          </button>
        </div>
      )}
    </section>
  );
}

/** A gallery thumbnail. The core-files `/raw` endpoint is Bearer-gated, and a
 *  bare <img src> can't carry the SPA's token, so useImageSrc fetches it with
 *  the token. A tap opens the shared viewer over the whole gallery. */
function GalleryImg({ thumb, alt, onOpen }: { thumb: string; alt: string; onOpen: () => void }) {
  const resolvedThumb = useImageSrc(thumb);
  if (!resolvedThumb) {
    return (
      <div className="w-full aspect-square bg-subtle dark:bg-slate-800 flex items-center justify-center text-faint dark:text-slate-500">
        <Camera size={20} />
      </div>
    );
  }
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${alt}`} className="block w-full cursor-zoom-in">
      <EntityPhoto src={resolvedThumb} alt={alt} aspect="square" />
    </button>
  );
}
