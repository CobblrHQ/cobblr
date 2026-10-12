// /files/:id: one file's own page, the address search, tags, saved views and
// Cobb hand out for a file (core-files' detailRoute). It shows the file (an
// image at medium size, anything a renderer can show in place, the rest one
// tap from opening), what it is attached to, and the same actions the Files
// list offers: open, rename, move, delete.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, File as FileIcon, Pencil, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { openAuthedFile } from "../lib/authed-file";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { canPreviewFile, CustomFieldsPanel, EntityPhoto, FilePreview, useConfirm, useFilePreviewRegistry, usePageTitle, useToast } from "@cobblr/platform-web";
import { folderPaths, formatBytes } from "../features/core-files/fileFormat";
import { ContributedDetailPanels } from "../panels/registry";
import { ImageLightbox } from "../components/ImageLightbox";

export function FileDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  useFilePreviewRegistry();

  const file = useQuery({ queryKey: ["file", activeSlug, id], queryFn: () => api.getFile(activeSlug, id), enabled: !!activeSlug && !!id, retry: false });
  const usedBy = useQuery({ queryKey: ["file-used-by", activeSlug, id], queryFn: () => api.fileUsedBy(activeSlug, id), enabled: !!file.data });
  const folders = useQuery({ queryKey: ["file-folders", activeSlug], queryFn: () => api.listFileFolders(activeSlug), enabled: !!activeSlug });
  usePageTitle(file.data?.filename ?? "File");

  const paths = useMemo(() => folderPaths(folders.data?.items ?? []), [folders.data]);
  const pathLabel = (folderId: string | null | undefined) => (folderId ? (paths.get(folderId) ?? []).map((f) => f.name).join(" / ") || "a folder" : "Top level");
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : (err as Error).message);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["file", activeSlug, id] });
    void qc.invalidateQueries({ queryKey: ["files", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["file-folders", activeSlug] });
  };

  const update = useMutation({
    mutationFn: (body: { filename?: string; folder_id?: string | null }) => api.updateFile(activeSlug, id, body),
    onSuccess: (_r, body) => {
      if (body.folder_id !== undefined) toast.success(`Moved to ${pathLabel(body.folder_id)}`);
      refresh();
    },
    onError: fail,
  });
  const setField = useMutation({
    mutationFn: (metadata: Record<string, unknown>) => api.updateFile(activeSlug, id, { metadata }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteFile(activeSlug, id),
    onSuccess: () => {
      toast.action("File moved to Recently deleted.", {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            await api.restoreFile(activeSlug, id);
            await qc.invalidateQueries();
            toast.success("File restored.");
            navigate(`/files/${id}`);
          } catch (err) { fail(err); }
        },
      });
      void qc.invalidateQueries({ queryKey: ["files", activeSlug] });
      navigate("/files");
    },
    onError: fail,
  });

  if (file.isLoading) return <div className="text-sm text-muted">Loading…</div>;
  if (!file.data) {
    const gone = file.error instanceof ApiError && file.error.status === 404;
    return (
      <div className="space-y-3" data-testid="file-missing">
        <BackToFiles />
        <p className="text-sm text-muted">{gone ? "This file was deleted, or is not in this workspace." : "This file could not be loaded. Try again in a moment."}</p>
      </div>
    );
  }

  const f = file.data;
  const commitRename = () => {
    const value = (renaming ?? "").trim();
    if (value && value !== f.filename) update.mutate({ filename: value });
    setRenaming(null);
  };
  const askDelete = async () => {
    const ok = await confirm({ title: "Delete this file?", message: `${f.filename} goes to Recently deleted; things it is attached to keep it.`, confirmLabel: "Delete", destructive: true });
    if (ok) remove.mutate();
  };
  const open = () => void openAuthedFile(activeSlug, f.id, { mime: f.mime_type, filename: f.filename });
  const users = usedBy.data?.items ?? [];

  return (
    <div className="space-y-5 max-w-4xl">
      <BackToFiles />
      <div className="flex flex-wrap items-center gap-2 border-b border-line dark:border-slate-700 pb-3">
        <FileIcon size={18} className="text-faint shrink-0" />
        {renaming !== null ? (
          <input
            autoFocus
            aria-label="File name"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
            className="flex-1 min-w-0 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1 text-lg"
          />
        ) : (
          <h1 className="flex-1 min-w-0 truncate text-xl font-semibold text-content dark:text-mortar-100">{f.filename}</h1>
        )}
        <button type="button" onClick={() => setRenaming(f.filename)} aria-label="Rename" title="Rename" className="text-faint hover:text-accent p-1.5">
          <Pencil size={15} />
        </button>
        <button type="button" onClick={open} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm hover:text-accent">
          <ExternalLink size={14} /> Open
        </button>
        <button type="button" onClick={() => void askDelete()} aria-label="Delete" title="Delete" className="text-faint hover:text-ember-500 p-1.5">
          <Trash2 size={15} />
        </button>
      </div>

      {viewing && f.kind === "image" && (
        <ImageLightbox items={[{ key: f.id, caption: f.filename, file: { slug: activeSlug, fileId: f.id } }]} index={0} onClose={() => setViewing(false)} />
      )}
      <section aria-label="Preview" className="rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-900/40 p-2">
        {f.kind === "image" ? (
          <button title={`Open ${f.filename}`} type="button" onClick={() => setViewing(true)} aria-label={`Open ${f.filename}`} className="relative block w-full aspect-[4/3] max-h-[70vh] cursor-zoom-in">
            <EntityPhoto src={api.fileRawUrl(activeSlug, f.id, "medium")} alt={f.filename} fill fit="contain" />
          </button>
        ) : canPreviewFile(f.filename) ? (
          <FilePreview src={api.fileRawUrl(activeSlug, f.id, "original")} filename={f.filename} className="min-h-[50vh]" />
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted">
            <FileIcon size={32} className="text-faint" />
            <span>This kind of file opens in its own app.</span>
            <button type="button" onClick={open} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm">
              Open {f.filename}
            </button>
          </div>
        )}
      </section>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted">Size</dt>
        <dd className="tabular-nums">{formatBytes(f.size_bytes)}</dd>
        {f.width && f.height ? (
          <>
            <dt className="text-muted">Dimensions</dt>
            <dd className="tabular-nums">
              {f.width} × {f.height}
            </dd>
          </>
        ) : null}
        <dt className="text-muted">Added</dt>
        <dd>{new Date(f.created_at).toLocaleString()}</dd>
        <dt className="text-muted">Folder</dt>
        <dd>
          <select
            aria-label="Folder"
            value={f.folder_id ?? ""}
            onChange={(e) => update.mutate({ folder_id: e.target.value || null })}
            className="max-w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 text-sm px-1 py-0.5"
          >
            <option value="">Top level</option>
            {[...paths.entries()]
              .map(([fid, p]) => [fid, p.map((x) => x.name).join(" / ")] as const)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([fid, label]) => (
                <option key={fid} value={fid}>
                  {label}
                </option>
              ))}
          </select>
        </dd>
      </dl>

      <section aria-label="Used by" data-testid="file-used-by">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">// used by</h3>
        {usedBy.isLoading ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : users.length === 0 ? (
          <div className="text-sm text-muted italic">Not attached to anything yet.</div>
        ) : (
          <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
            {users.map((u) => (
              <li key={u.attachment_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                {u.detail_url ? (
                  <Link to={u.detail_url} className="flex-1 min-w-0 truncate hover:text-accent">
                    {u.title}
                  </Link>
                ) : (
                  <span className="flex-1 min-w-0 truncate">{u.title}</span>
                )}
                {u.role && <span className="text-xs text-faint">{roleLabel(u.role)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The file's own fields, as a bundle or a person defines them. */}
      <CustomFieldsPanel entityKind="core-files:file" entityId={f.id} values={f.metadata ?? {}} onCommit={(name, value) => setField.mutate({ [name]: value })} />

      <ContributedDetailPanels target="core-files:file" ctx={{ slug: activeSlug, entityId: f.id, entityTitle: f.filename }} />
    </div>
  );
}

function BackToFiles() {
  return (
    <Link to="/files" className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent">
      <ArrowLeft size={14} /> Files
    </Link>
  );
}

function roleLabel(role: string): string {
  if (role === "hero") return "main photo";
  if (role === "gallery") return "photo";
  return role.replace(/[_-]+/g, " ");
}
