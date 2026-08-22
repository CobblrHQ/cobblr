// /files — gallery + upload + delete for core-files.
//
// Minimal v0.1: a grid of thumbnails for images, a row list for
// documents, an upload button that drops files via the same
// multipart endpoint the demos use. Delete is soft (the module
// flips deleted_at; the row drops out of the list).

import { useRef, useState } from "react";
import { openAuthedFile } from "../lib/authed-file";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File as FileIcon, Trash2, Upload } from "lucide-react";
import { api, type FileRecord } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useImageSrc, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

export function FilesPage() {
  usePageTitle("Files");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const list = useQuery({
    queryKey: ["files", activeSlug],
    queryFn: () => api.listFiles(activeSlug),
    enabled: !!activeSlug,
  });

  const uploadOne = useMutation({
    mutationFn: (file: File) => api.uploadFile(activeSlug, file),
    onSuccess: (r) => {
      toast.success(`Uploaded ${r.filename}`);
      void qc.invalidateQueries({ queryKey: ["files", activeSlug] });
    },
    onError: (err) => toast.error(`Upload failed: ${(err as Error).message}`),
  });

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      try {
        await uploadOne.mutateAsync(f);
      } catch {
        /* toast already fired */
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  const deleteFile = useMutation({
    mutationFn: (id: string) => api.deleteFile(activeSlug, id),
    onSuccess: () => {
      toast.success("File deleted");
      void qc.invalidateQueries({ queryKey: ["files", activeSlug] });
    },
  });

  const items = list.data?.items ?? [];
  const images = items.filter((f) => f.kind === "image");
  const others = items.filter((f) => f.kind !== "image");

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Files</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} {items.length === 1 ? "file" : "files"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm transition"
        >
          <Upload size={14} />
          {uploading ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400">Loading…</div>
      )}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No files yet. Drop one in to get started.
        </div>
      )}

      {images.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-content dark:text-slate-300 mb-3">
            Images
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {images.map((f) => (
              <ImageTile
                key={f.id}
                file={f}
                slug={activeSlug}
                onDelete={async () => {
                  const ok = await confirm({
                    title: "Delete this file?",
                    message: `${f.filename} will be soft-deleted (existing attachments stay intact).`,
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) deleteFile.mutate(f.id);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-content dark:text-slate-300 mb-3">
            Other files
          </h2>
          <div className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
            {others.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <FileIcon size={16} className="text-faint" />
                {/* Bearer-only auth: a plain href would 401 — blob-fetch
                    with the token and hand the browser an object URL. */}
                <button
                  type="button"
                  onClick={() => void openAuthedFile(activeSlug, f.id)}
                  className="flex-1 truncate text-left hover:text-accent"
                >
                  {f.filename}
                </button>
                <span className="text-xs text-muted dark:text-slate-400 tabular-nums">
                  {formatBytes(f.size_bytes)}
                </span>
                <button
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete this file?",
                      message: f.filename,
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) deleteFile.mutate(f.id);
                  }}
                  className="text-faint hover:text-ember-500 transition"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ImageTile({
  file,
  slug,
  onDelete,
}: {
  file: FileRecord;
  slug: string;
  onDelete: () => void;
}) {
  return (
    <div className="group relative aspect-square rounded overflow-hidden border border-line dark:border-slate-700">
      {/* Auth is Bearer-header-only — a plain <img src> sends no credentials
          and 401s (the "all I see is broken images" report). useImageSrc
          blob-fetches with the token, like every other thumbnail. */}
      <AuthedThumb slug={slug} file={file} />
              // TOUCH-OK: a filename gradient over a tile that is itself the
              // link; the tile opens the file with or without this.
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition">
        <div className="text-xs text-white truncate" title={file.filename}>
          {file.filename}
        </div>
      </div>
      <button
        onClick={onDelete}
        className="absolute top-1 right-1 p-1 rounded bg-black/40 text-white hover-reveal hover:bg-ember-600 transition"
        title="Delete"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}


/** Image-grid thumbnail via useImageSrc (token-authenticated blob). */
function AuthedThumb({ slug, file }: { slug: string; file: FileRecord }) {
  const src = useImageSrc(api.fileRawUrl(slug, file.id, "thumb"));
  if (!src) {
    return <div className="w-full h-full bg-subtle/60 dark:bg-slate-800/60 animate-pulse" />;
  }
  return <img src={src} alt={file.filename} className="w-full h-full object-cover" />;
}
