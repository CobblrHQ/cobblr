// Part-page photo gallery. Lists every core-files attachment with
// role='gallery' for (inventory, part, id) plus a drop zone for new
// uploads. The first image doubles as the cover unless image_path is
// explicitly set.
//
// Self-contained (no extra shared component needed) — it reaches
// core-files directly via the inventory module's orgSlug + getToken.

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Star, Trash2, Upload, X } from "lucide-react";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";

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
  const { orgSlug, getToken } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  const base = `/api/v1/orgs/${orgSlug}/modules/core-files`;

  const list = useQuery({
    queryKey: ["part-gallery", orgSlug, partId],
    queryFn: async () => {
      const res = await fetch(
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
      const ures = await fetch(`${base}/files`, {
        method: "POST",
        headers: auth(),
        body: fd,
      });
      if (!ures.ok) throw new Error(`upload ${ures.status}`);
      const f = (await ures.json()) as { id: string };
      const ares = await fetch(`${base}/attachments`, {
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
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["part-gallery", orgSlug, partId] });
    },
    onError: (e) => toast.error(`Upload failed: ${(e as Error).message}`),
  });

  const detach = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/attachments/${id}`, {
        method: "DELETE",
        headers: auth(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["part-gallery", orgSlug, partId] });
    },
  });

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        await upload.mutateAsync(f);
      } catch {
        /* toast already fired */
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

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
        "rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 transition " +
        (dragOver
          ? "ring-2 ring-cobble-400 ring-offset-2 dark:ring-offset-slate-900"
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
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 flex items-center gap-2">
          <Camera size={11} /> Photos
          {dragOver && (
            <span className="text-cobble-600 normal-case tracking-normal font-normal">
              drop to upload
            </span>
          )}
        </h3>
        <label className="text-[11px] font-mono uppercase tracking-widest text-slate-500 hover:text-cobble-600 cursor-pointer inline-flex items-center gap-1">
          <Upload size={11} /> {upload.isPending ? "uploading…" : "add"}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </label>
      </div>
      {list.isLoading && (
        <div className="text-xs text-slate-400">loading…</div>
      )}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-slate-400 italic border border-dashed border-slate-200 dark:border-slate-700 rounded-lg p-6 text-center">
          No photos yet. Drag-and-drop or click "add" above.
        </div>
      )}
      {items.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {items.map((att) => {
            const isCover = !!coverImagePath && coverImagePath.endsWith(att.file_id);
            return (
              <div
                key={att.id}
                className={
                  "relative group rounded-md overflow-hidden border " +
                  (isCover
                    ? "border-cobble-400 dark:border-cobble-500 ring-2 ring-cobble-300/40"
                    : "border-slate-200 dark:border-slate-700")
                }
              >
                <a href={fullUrl(att.file_id)} target="_blank" rel="noopener noreferrer">
                  <img
                    src={thumbUrl(att.file_id)}
                    alt={att.filename}
                    className="w-full aspect-square object-cover"
                    loading="lazy"
                  />
                </a>
                {isCover && (
                  <div className="absolute top-1 left-1 text-[9px] font-mono uppercase tracking-widest bg-cobble-600 text-white rounded px-1.5 py-0.5">
                    cover
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1 flex items-center justify-between gap-1 opacity-0 group-hover:opacity-100 transition">
                  {!isCover && (
                    <button
                      type="button"
                      onClick={() => onSetCover(fullUrl(att.file_id))}
                      className="text-[10px] text-white/90 hover:text-white inline-flex items-center gap-0.5"
                      title="Set as cover"
                    >
                      <Star size={10} /> cover
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Remove photo?",
                        message: "The file stays in your library; only the attachment to this part is removed.",
                        confirmLabel: "Remove",
                        destructive: true,
                      });
                      if (ok) detach.mutate(att.id);
                    }}
                    className="text-[10px] text-white/80 hover:text-white inline-flex items-center gap-0.5 ml-auto"
                    title="Remove"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* Surface a tiny X if uploading mid-drag so the user can cancel/reset if needed. */}
      {upload.isPending && (
        <div className="text-[10px] font-mono text-cobble-500 mt-2 inline-flex items-center gap-1">
          <Upload size={10} className="animate-pulse" /> uploading
          <button type="button" onClick={() => upload.reset()} title="Reset state">
            <X size={10} />
          </button>
        </div>
      )}
    </section>
  );
}
