// Files on a design — the pattern PDF the extraction stored, photos of the
// finished/target make, anything else attached to (projects, project, id).
// Images render as authed thumbnails; other files (the pattern) as chips.
// Upload accepts images + PDFs: a PDF lands as role=pattern, an image as
// role=gallery. Mirrors inventory's PartGallery, slimmed (no cover logic).

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Trash2, Upload } from "lucide-react";
import { useConfirm, useImageSrc } from "@cobblr/platform-web";
import { useProjects } from "./context";

interface AttachmentRow {
  id: string;
  file_id: string;
  filename: string;
  mime_type: string;
  kind: string;
  role: string | null;
}

export function DesignFiles({ designId }: { designId: string }) {
  const { orgSlug, getToken } = useProjects();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  const base = `/api/v1/orgs/${orgSlug}/modules/core-files`;

  const list = useQuery({
    queryKey: ["design-files", orgSlug, designId],
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
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["design-files", orgSlug, designId] }),
  });

  const detach = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/attachments/${id}`, { method: "DELETE", headers: auth() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["design-files", orgSlug, designId] }),
  });

  const items = list.data ?? [];
  const images = items.filter((a) => a.kind === "image" || a.mime_type.startsWith("image/"));
  const files = items.filter((a) => !(a.kind === "image" || a.mime_type.startsWith("image/")));

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // pattern &amp; photos
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-content dark:hover:text-mortar-100 transition"
        >
          <Upload size={13} /> add
        </button>
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
          No pattern or photos yet — upload the pattern PDF or a photo of the make.
        </p>
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Authed thumbnail — a bare <img> can't send the Bearer token. */
function DesignThumb({ thumb, full, alt }: { thumb: string; full: string; alt: string }) {
  const resolved = useImageSrc(thumb);
  const resolvedFull = useImageSrc(full);
  if (!resolved) {
    return <div className="aspect-square rounded-md bg-subtle dark:bg-slate-800 animate-pulse" />;
  }
  return (
    <a href={resolvedFull ?? undefined} target="_blank" rel="noreferrer" title={alt}>
      <img
        src={resolved}
        alt={alt}
        className="aspect-square w-full object-cover rounded-md border border-line dark:border-slate-700 hover:border-accent transition"
      />
    </a>
  );
}
