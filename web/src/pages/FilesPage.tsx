// /files: every file in the workspace, in folders a person arranges.
//
// A folder is only a place: renaming or moving never touches a file's bytes,
// and a folder that still holds anything cannot be deleted (it says what is
// inside), so tidying can never lose a file. Upload lands in the folder you
// are looking at; the same bytes uploaded again keep the one copy and say
// where it already is. Search finds a file by name wherever it lives. A
// deleted file waits in Recently deleted for 30 days, where it can be restored
// or deleted forever at once; after that its bytes are removed for good.

import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { openAuthedFile } from "../lib/authed-file";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, File as FileIcon, Folder, FolderPlus, Info, Pencil, RotateCcw, Trash2, Upload } from "lucide-react";
import { api, ApiError, type FileRecord } from "../lib/api";
import { folderPaths, formatBytes } from "../features/core-files/fileFormat";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ImageLightbox } from "../components/ImageLightbox";
import { canPreviewFile, FilePreview, FileIntakePanels, Modal, useFileIntake, useFilePreviewRegistry, useToast, useConfirm, usePageTitle, EntityPhoto, SearchInput, usePasteImage } from "@cobblr/platform-web";

const TOP = "top";

export function FilesPage() {
  usePageTitle("Files");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  // A screenshot pasted on the Files page is uploaded here like a chosen file.
  usePasteImage(() => fileInput.current?.parentElement ?? null, { onFiles: (files) => void intake.take(files), accept: "*", multiple: true });
  // A link can open a folder directly (a Make's page links to its folder).
  const [params] = useSearchParams();
  const [folder, setFolder] = useState<string>(() => {
    const asked = params.get("folder");
    return asked && /^[0-9a-f-]{36}$/i.test(asked) ? asked : TOP;
  });
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<{ kind: "file" | "folder"; id: string; value: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  // A file the app can show (a PDF, an SVG, a model) opens in place; the
  // rest open in a new tab.
  const [reading, setReading] = useState<FileRecord | null>(null);
  // The picture open in the shared viewer, which steps through this folder's images.
  const [viewing, setViewing] = useState<number | null>(null);
  useFilePreviewRegistry();

  const searching = search.trim().length > 0;
  const folders = useQuery({ queryKey: ["file-folders", activeSlug], queryFn: () => api.listFileFolders(activeSlug), enabled: !!activeSlug });
  const usage = useQuery({ queryKey: ["files", activeSlug, "usage"], queryFn: () => api.fileUsage(activeSlug), enabled: !!activeSlug });
  const list = useInfiniteQuery({
    queryKey: ["files", activeSlug, searching ? `q:${search.trim()}` : folder],
    queryFn: ({ pageParam }) => api.listFiles(activeSlug, undefined, { ...(searching ? { q: search.trim() } : { folder }), limit: 100, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!activeSlug,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["files", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["file-folders", activeSlug] });
  };
  // The server's own sentence ("This folder still holds 3 files. Move them
  // out first.") is the message.
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : (err as Error).message);

  const all = folders.data?.items ?? [];
  const paths = useMemo(() => folderPaths(all), [all]);
  const here = folder === TOP ? [] : (paths.get(folder) ?? []);
  const children = all.filter((f) => (f.parent_id ?? TOP) === folder);
  const pathLabel = (id: string | null | undefined) => (id ? (paths.get(id) ?? []).map((f) => f.name).join(" / ") || "a folder" : "the top level");

  // The one drop zone (platform-web FileIntake), the same the Patterns page
  // uses: a batch reports once, a zip asks whether to unpack its folders.
  const intake = useFileIntake({
    orgSlug: activeSlug,
    folderId: folder === TOP ? null : folder,
    onResults: () => refresh(),
  });

  const [showDeleted, setShowDeleted] = useState(false);
  const deleted = useQuery({
    queryKey: ["files", activeSlug, "deleted"],
    queryFn: () => api.listDeletedFiles(activeSlug),
    enabled: !!activeSlug,
  });
  const restoreFile = useMutation({
    mutationFn: (f: { id: string; filename: string }) => api.restoreFile(activeSlug, f.id),
    onSuccess: (_r, f) => {
      toast.success(`Restored ${f.filename}`);
      refresh();
    },
    onError: fail,
  });
  const purgeFile = useMutation({
    mutationFn: (id: string) => api.deleteFileForever(activeSlug, id),
    onSuccess: () => {
      toast.success("Deleted forever");
      refresh();
    },
    onError: fail,
  });
  const deleteFile = useMutation({
    mutationFn: (f: { id: string; filename: string }) => api.deleteFile(activeSlug, f.id),
    onSuccess: (_r, f) => {
      toast.action(`${f.filename} moved to Recently deleted.`, {
        actionLabel: "Undo",
        onAction: () => restoreFile.mutate(f),
      });
      refresh();
    },
    onError: fail,
  });
  const updateFile = useMutation({
    mutationFn: (v: { id: string; filename?: string; folder_id?: string | null }) => api.updateFile(activeSlug, v.id, { filename: v.filename, folder_id: v.folder_id }),
    onSuccess: (r, v) => {
      if (v.folder_id !== undefined) toast.success(`Moved ${r.filename} to ${pathLabel(v.folder_id)}`);
      refresh();
    },
    onError: fail,
  });
  const createFolder = useMutation({
    mutationFn: (name: string) => api.createFileFolder(activeSlug, { name, parent_id: folder === TOP ? null : folder }),
    onSuccess: refresh,
    onError: fail,
  });
  const updateFolder = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.updateFileFolder(activeSlug, v.id, { name: v.name }),
    onSuccess: refresh,
    onError: fail,
  });
  const deleteFolder = useMutation({
    mutationFn: (id: string) => api.deleteFileFolder(activeSlug, id),
    onSuccess: refresh,
    onError: fail,
  });

  const commitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim();
    if (value) {
      if (renaming.kind === "file") updateFile.mutate({ id: renaming.id, filename: value });
      else updateFolder.mutate({ id: renaming.id, name: value });
    }
    setRenaming(null);
  };
  const renameInput = (
    <input
      autoFocus
      value={renaming?.value ?? ""}
      onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") setRenaming(null);
      }}
      className="flex-1 min-w-0 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1 text-sm"
    />
  );

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? items.length;
  const images = items.filter((f) => f.kind === "image");
  const others = items.filter((f) => f.kind !== "image");
  const askDelete = async (f: FileRecord) => {
    const ok = await confirm({ title: "Delete this file?", message: `${f.filename} goes to Recently deleted for 30 days, where you can restore it.`, confirmLabel: "Delete", destructive: true });
    if (ok) deleteFile.mutate({ id: f.id, filename: f.filename });
  };
  const moveMenu = (f: FileRecord) => (
    <select
      aria-label={`Move ${f.filename}`}
      value=""
      onChange={(e) => {
        const to = e.target.value;
        if (to) updateFile.mutate({ id: f.id, folder_id: to === TOP ? null : to });
      }}
      className="shrink-0 max-w-[9rem] rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 text-xs text-muted px-1 py-1"
    >
      <option value="">Move to…</option>
      {(f.folder_id ?? null) !== null && <option value={TOP}>Top level</option>}
      {[...paths.entries()]
        .filter(([id]) => id !== f.folder_id)
        .map(([id, p]) => [id, p.map((x) => x.name).join(" / ")] as const)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
    </select>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 mr-2">Files</h1>
        {usage.data && (
          <span className="text-xs text-muted tabular-nums" data-testid="files-usage">
            {formatBytes(usage.data.bytes_used)} {usage.data.quota_bytes ? `of ${formatBytes(usage.data.quota_bytes)}` : "used"}
          </span>
        )}
        <div className="flex-1" />
        <SearchInput value={search} onChange={setSearch} placeholder="Find a file by name" aria-label="Find a file by name" wrapperClassName="w-44 sm:w-56" />
        {newFolder === null ? (
          <button
            type="button"
            onClick={() => setNewFolder("")}
            className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm hover:text-accent"
          >
            <FolderPlus size={14} /> New folder
          </button>
        ) : (
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newFolder.trim();
              if (name) createFolder.mutate(name);
              setNewFolder(null);
            }}
          >
            <input
              autoFocus
              aria-label="New folder name"
              value={newFolder}
              placeholder="Folder name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setNewFolder(null)}
              className="w-36 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm"
            />
            <button type="submit" className="rounded border border-line dark:border-slate-700 px-2 py-1.5 text-sm hover:text-accent">
              Make
            </button>
          </form>
        )}
        <button
          onClick={() => fileInput.current?.click()}
          disabled={intake.busy}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm transition"
        >
          <Upload size={14} />
          {intake.progress ? `Uploading ${intake.progress.done + 1} of ${intake.progress.of}…` : intake.busy ? "Importing…" : "Upload"}
        </button>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = "";
            void intake.take(files);
          }} />
      </div>

      <FileIntakePanels intake={intake} where={folder === TOP ? "here" : `into ${pathLabel(folder)}`} />

      {searching ? (
        <div className="text-sm text-muted">
          {total} file{total === 1 ? "" : "s"} named like “{search.trim()}”, in every folder
        </div>
      ) : (
        <nav aria-label="Folder" className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => setFolder(TOP)} className={folder === TOP ? "font-medium text-content dark:text-mortar-100" : "text-muted hover:text-accent"}>
            All folders
          </button>
          {here.map((f, i) => (
            <span key={f.id} className="inline-flex items-center gap-1">
              <ChevronRight size={13} className="text-faint" />
              <button type="button" onClick={() => setFolder(f.id)} className={i === here.length - 1 ? "font-medium text-content dark:text-mortar-100" : "text-muted hover:text-accent"}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      {!searching && children.length > 0 && (
        <section aria-label="Folders" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {children.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded border border-line dark:border-slate-700 px-3 py-2 text-sm">
              <Folder size={16} className="text-accent shrink-0" />
              {renaming?.kind === "folder" && renaming.id === f.id ? (
                renameInput
              ) : (
                <button type="button" onClick={() => setFolder(f.id)} className="flex-1 min-w-0 truncate text-left hover:text-accent">
                  {f.name}
                  <span className="text-xs text-faint"> · {f.file_count}</span>
                </button>
              )}
              <button type="button" title="Rename" aria-label={`Rename ${f.name}`} onClick={() => setRenaming({ kind: "folder", id: f.id, value: f.name })} className="text-faint hover:text-accent p-1">
                <Pencil size={13} />
              </button>
              <button type="button" title="Delete" aria-label={`Delete ${f.name}`} onClick={() => deleteFolder.mutate(f.id)} className="text-faint hover:text-ember-500 p-1">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </section>
      )}

      {list.isLoading && <div className="text-sm text-muted dark:text-slate-400">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          {searching ? "No file has that in its name." : folder === TOP ? "No files here yet. Upload one, or make a folder to start sorting." : "This folder is empty. Upload into it, or move files here."}
        </div>
      )}

      {viewing !== null && images[viewing] && (
        <ImageLightbox
          items={images.map((f) => ({ key: f.id, caption: f.filename, file: { slug: activeSlug, fileId: f.id } }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
      {images.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-content dark:text-slate-300 mb-3">Images</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {images.map((f, i) => (
              <div key={f.id} className="space-y-1">
                <ImageTile file={f} slug={activeSlug} onOpen={() => setViewing(i)} onDelete={() => void askDelete(f)} />
                <div className="flex items-center gap-1">
                  {renaming?.kind === "file" && renaming.id === f.id ? (
                    renameInput
                  ) : (
                    <button type="button" onClick={() => setRenaming({ kind: "file", id: f.id, value: f.filename })} className="flex-1 min-w-0 truncate text-left text-xs text-muted hover:text-accent" title="Rename">
                      {f.filename}
                    </button>
                  )}
                  <Link to={`/files/${f.id}`} title="Details" aria-label={`Details of ${f.filename}`} className="shrink-0 text-faint hover:text-accent p-1">
                    <Info size={13} />
                  </Link>
                  {moveMenu(f)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-content dark:text-slate-300 mb-3">{images.length > 0 ? "Other files" : "Files"}</h2>
          <div className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
            {others.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <FileIcon size={16} className="text-faint shrink-0" />
                {renaming?.kind === "file" && renaming.id === f.id ? (
                  renameInput
                ) : (
                  // Bearer-only auth: a plain href would 401, so the viewer or
                  // openAuthedFile fetches with the token.
                  <button
                    type="button"
                    onClick={() => (canPreviewFile(f.filename) ? setReading(f) : void openAuthedFile(activeSlug, f.id, { mime: f.mime_type, filename: f.filename }))}
                    className="flex-1 min-w-0 truncate text-left hover:text-accent"
                  >
                    {f.filename}
                    {searching && <span className="text-xs text-faint"> · {pathLabel(f.folder_id)}</span>}
                  </button>
                )}
                <span className="text-xs text-muted dark:text-slate-400 tabular-nums">{formatBytes(f.size_bytes)}</span>
                <Link to={`/files/${f.id}`} title="Details" aria-label={`Details of ${f.filename}`} className="text-faint hover:text-accent p-1">
                  <Info size={13} />
                </Link>
                <button type="button" title="Rename" aria-label={`Rename ${f.filename}`} onClick={() => setRenaming({ kind: "file", id: f.id, value: f.filename })} className="text-faint hover:text-accent p-1">
                  <Pencil size={13} />
                </button>
                {moveMenu(f)}
                <button type="button" onClick={() => void askDelete(f)} className="text-faint hover:text-ember-500 transition p-1" title="Delete" aria-label={`Delete ${f.filename}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {list.hasNextPage && (
        <div className="flex items-center justify-center gap-3 text-sm text-muted">
          <span>
            {items.length} of {total}
          </span>
          <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} className="rounded border border-line dark:border-slate-700 px-3 py-1.5 hover:text-accent disabled:opacity-50">
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {(deleted.data?.items.length ?? 0) > 0 && (
        <section aria-label="Recently deleted" className="border-t border-line dark:border-slate-700 pt-3">
          <button
            type="button"
            onClick={() => setShowDeleted((v) => !v)}
            aria-expanded={showDeleted}
            className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent"
          >
            <ChevronRight size={13} className={showDeleted ? "rotate-90 transition" : "transition"} />
            Recently deleted ({deleted.data!.items.length})
          </button>
          {showDeleted && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted">Deleted files stay here for {deleted.data!.days} days, then they are removed for good.</p>
              <div className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
                {deleted.data!.items.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="deleted-file">
                    <FileIcon size={16} className="text-faint shrink-0" />
                    <span className="flex-1 min-w-0 basis-40 truncate">{f.filename}</span>
                    <span className="text-xs text-muted tabular-nums">{daysLeft(f.purge_after)}</span>
                    <button
                      type="button"
                      onClick={() => restoreFile.mutate({ id: f.id, filename: f.filename })}
                      className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 px-2 py-1 text-xs hover:text-accent"
                    >
                      <RotateCcw size={12} /> Restore
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete forever?",
                          message: `${f.filename} will be removed now and cannot be brought back.`,
                          confirmLabel: "Delete forever",
                          destructive: true,
                        });
                        if (ok) purgeFile.mutate(f.id);
                      }}
                      className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 px-2 py-1 text-xs text-muted hover:text-ember-500"
                    >
                      <Trash2 size={12} /> Delete forever
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
      {reading && (
        <Modal open onClose={() => setReading(null)} title={reading.filename} size="lg" fillHeight>
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={() => void openAuthedFile(activeSlug, reading.id, { mime: reading.mime_type, filename: reading.filename })}
              className="text-xs text-muted hover:text-accent underline decoration-dotted underline-offset-2"
            >
              Open in a new tab
            </button>
          </div>
          <FilePreview src={api.fileRawUrl(activeSlug, reading.id, "original")} filename={reading.filename} />
        </Modal>
      )}
    </div>
  );
}

function ImageTile({ file, slug, onOpen, onDelete }: { file: FileRecord; slug: string; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="group relative aspect-square rounded overflow-hidden border border-line dark:border-slate-700">
      {/* Auth is Bearer-header-only — a plain <img src> sends no credentials
          and 401s (the "all I see is broken images" report). useImageSrc
          blob-fetches with the token, like every other thumbnail. */}
      <button type="button" onClick={onOpen} aria-label={`Open ${file.filename}`} className="absolute inset-0 cursor-zoom-in">
        <AuthedThumb slug={slug} file={file} />
      </button>
      <button onClick={onDelete} className="absolute top-1 right-1 p-1 rounded bg-black/40 text-white hover-reveal hover:bg-ember-600 transition" title="Delete">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** "Gone in 12 days", from when the file is removed for good. */
function daysLeft(purgeAfter: string): string {
  const days = Math.ceil((new Date(purgeAfter).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "Removed soon";
  return days === 1 ? "Gone in 1 day" : `Gone in ${days} days`;
}

/** Image-grid thumbnail via useImageSrc (token-authenticated blob). */
function AuthedThumb({ slug, file }: { slug: string; file: FileRecord }) {
  return <EntityPhoto src={api.fileRawUrl(slug, file.id, "thumb")} alt={file.filename} fill />;
}
