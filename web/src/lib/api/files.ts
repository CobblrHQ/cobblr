import { type Edit } from "@cobblr/platform-web";
import { request, upload } from "./client";
import { walkPages } from "../list-pages";

// ─── Types for the methods above ────────────────────────────────────
export interface FileRecord {
  id: string;
  /** Custom fields a bundle or a person defines for files. */
  metadata?: Record<string, unknown>;
  filename: string;
  mime_type: string;
  size_bytes: number;
  kind: "image" | "document" | "video" | "other";
  width: number | null;
  height: number | null;
  variants: {
    original: { path: string; bytes: number };
    medium?: { path: string; bytes: number; width: number; height: number };
    thumb?: { path: string; bytes: number; width: number; height: number };
  };
  created_at: string;
  /** The folder it lives in; null is the top level. */
  folder_id?: string | null;
  /** On an upload: the same bytes were already here. */
  duplicate?: boolean;
  duplicate_of?: { id: string; filename: string; folder_id: string | null } | null;
}

/** One record a file is attached to (core-files `/files/:id/used-by`). */
export interface FileUsedBy {
  attachment_id: string;
  kind: string;
  id: string;
  role: string | null;
  title: string;
  detail_url: string | null;
}

/** A folder files live in (core-files), nested by `parent_id`. */
export interface FileFolder {
  id: string;
  parent_id: string | null;
  name: string;
  file_count: number;
  created_at: string;
}
/** A renderer the workspace has installed (GET .../core-file-preview/renderers). */
export interface InstalledRenderer {
  id: string;
  name: string;
  version: string | null;
  exts: string[];
  renderer_js: string;
  signed_by: string | null;
}

export const filesApi = {

  // ─── installed file-preview renderers (core-file-preview, per workspace) ──
  getInstalledRenderers: (slug: string) =>
    request<{ items: InstalledRenderer[] }>("GET", `/orgs/${slug}/modules/core-file-preview/renderers`),
  installRenderer: (
    slug: string,
    body: { name: string; version?: string; exts: string[]; renderer_js: string; pubkey?: string; signature?: string },
  ) =>
    request<InstalledRenderer>("POST", `/orgs/${slug}/modules/core-file-preview/renderers`, body),
  uninstallRenderer: (slug: string, name: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-file-preview/renderers/${encodeURIComponent(name)}`),

  // ─── core-files ───────────────────────────────────────────────────
  /** `folder`: "top" for the top level, a folder id for that folder, absent
   *  for every file wherever it lives. `q` matches the name. */
  listFiles: (slug: string, kind?: string, opts: { folder?: string; q?: string; limit?: number; cursor?: string } = {}) => {
    const p = new URLSearchParams();
    if (kind) p.set("kind", kind);
    if (opts.folder) p.set("folder", opts.folder);
    if (opts.q) p.set("q", opts.q);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.cursor) p.set("cursor", opts.cursor);
    const qs = p.toString();
    return request<{ items: FileRecord[]; next_cursor?: string | null; total?: number }>("GET", `/orgs/${slug}/modules/core-files/files${qs ? `?${qs}` : ""}`);
  },
  /** Lots going off within `within` days, wherever they are, grouped by place. */
  fileUsage: (slug: string) => request<{ bytes_used: number; quota_bytes: number | null }>("GET", `/orgs/${slug}/modules/core-files/files/usage`),
  listFileFolders: (slug: string) => request<{ items: FileFolder[]; top_level_file_count: number }>("GET", `/orgs/${slug}/modules/core-files/folders`),
  createFileFolder: (slug: string, body: { name: string; parent_id?: string | null }) => request<FileFolder>("POST", `/orgs/${slug}/modules/core-files/folders`, body),
  updateFileFolder: (slug: string, id: string, body: { name?: string; parent_id?: string | null }) => request<FileFolder>("PATCH", `/orgs/${slug}/modules/core-files/folders/${id}`, body),
  deleteFileFolder: (slug: string, id: string) => request<void>("DELETE", `/orgs/${slug}/modules/core-files/folders/${id}`),
  /** Rename a file, or move it to a folder (null: the top level). */
  getFile: (slug: string, id: string) => request<FileRecord>("GET", `/orgs/${slug}/modules/core-files/files/${id}`),
  /** The records a file is attached to, titled and with where each opens. */
  fileUsedBy: (slug: string, id: string) => request<{ items: FileUsedBy[] }>("GET", `/orgs/${slug}/modules/core-files/files/${id}/used-by`),
  /** `edit` from editOf: only what changed, and what it was when the form opened (#7925). */
  updateFile: (slug: string, id: string, edit: Edit<{ filename?: string; folder_id?: string | null; metadata?: Record<string, unknown> }>) => request<FileRecord>("PATCH", `/orgs/${slug}/modules/core-files/files/${id}`, edit.body, edit.headers),
  uploadFile: async (slug: string, file: File, opts: { folderId?: string | null; onDuplicate?: "skip"; camera?: boolean } = {}): Promise<FileRecord> => {
    const form = new FormData();
    if (opts.folderId) form.set("folder_id", opts.folderId);
    if (opts.onDuplicate) form.set("on_duplicate", opts.onDuplicate);
    // A picture taken with the camera rather than chosen from the device: the
    // file remembers it (platform-contract photo-source).
    if (opts.camera) form.set("photo_source", "camera");
    form.set("file", file);
    return upload<FileRecord>(`/api/v1/orgs/${slug}/modules/core-files/files`, form, file);
  },
  deleteFile: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-files/files/${id}`),
  /** Recently deleted: files deleted in the last `days`, each with when it goes for good. */
  listDeletedFiles: async (slug: string) => {
    let days = 30;
    const answer = await walkPages(async (offset, limit) => {
      const page = await request<{ days: number; items: Array<FileRecord & { deleted_at: string; purge_after: string }>; total: number | null; complete: boolean }>(
        "GET", `/orgs/${slug}/modules/core-files/files/deleted?${new URLSearchParams({ offset: String(offset), limit: String(limit) })}`,
      );
      days = page.days;
      return page;
    });
    return { ...answer, days };
  },
  restoreFile: (slug: string, id: string) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-files/files/${id}/restore`),
  deleteFileForever: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-files/files/${id}/forever`),
  // IDEMPOTENT: image_path is stored as a FULL raw URL (uploads + web-image
  // enrich both do `fileRawUrl(id)`), so a caller that wraps an already-resolved
  // path/URL again must NOT double it (that yields `.../files//api/.../raw/raw`
  // → 404 → retry → modal flicker). A bare file id is wrapped; a full path or
  // external URL passes straight through.
  fileRawUrl: (slug: string, id: string, variant?: "medium" | "thumb" | "original") =>
    /^(https?:\/\/|\/)/.test(id)
      ? id
      : `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw${variant ? `?variant=${variant}` : ""}`,
};
