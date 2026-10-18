import { ApiError, getToken, request, upload } from "./client";

export interface VaultPerson { id: string; name: string }
export interface VaultFolder {
  id: string;
  name: string;
  owner: VaultPerson | null;
  mine: boolean;
  people: VaultPerson[];
  file_count: number;
  created_at: string;
}
export interface VaultFile {
  id: string;
  folder_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  record: { kind: string; id: string } | null;
  added_by: VaultPerson | null;
  created_at: string;
}
export interface VaultEvent { at: string; who: VaultPerson | null; action: string; file: string | null; detail: Record<string, unknown> }

export const vaultApi = {

  // ─── the Vault (#5242): folders a person's list decides ───────────
  vaultFolders: (slug: string) => request<{ items: VaultFolder[] }>("GET", `/orgs/${slug}/vault/folders`),
  vaultCreateFolder: (slug: string, name: string) => request<VaultFolder>("POST", `/orgs/${slug}/vault/folders`, { name }),
  vaultFolder: (slug: string, id: string) => request<VaultFolder & { files: VaultFile[] }>("GET", `/orgs/${slug}/vault/folders/${id}`),
  vaultUpdateFolder: (slug: string, id: string, change: { name?: string; people?: string[] }) =>
    request<VaultFolder & { files: VaultFile[] }>("PATCH", `/orgs/${slug}/vault/folders/${id}`, change),
  vaultDeleteFolder: (slug: string, id: string) => request<{ files: number }>("DELETE", `/orgs/${slug}/vault/folders/${id}`),
  vaultHistory: (slug: string, id: string) => request<{ items: VaultEvent[] }>("GET", `/orgs/${slug}/vault/folders/${id}/history`),
  vaultUpload: (slug: string, folderId: string, file: File, record?: { kind: string; id: string } | null) => {
    const form = new FormData();
    form.set("file", file);
    if (record) {
      form.set("record_kind", record.kind);
      form.set("record_id", record.id);
    }
    return upload<VaultFile>(`/api/v1/orgs/${slug}/vault/folders/${folderId}/files`, form, file);
  },
  vaultUpdateFile: (slug: string, id: string, change: { name?: string; folder_id?: string; record?: { kind: string; id: string } | null }) =>
    request<VaultFile>("PATCH", `/orgs/${slug}/vault/files/${id}`, change),
  vaultDeleteFile: (slug: string, id: string) => request<void>("DELETE", `/orgs/${slug}/vault/files/${id}`),
  vaultRecordDocuments: (slug: string, kind: string, id: string) =>
    request<{ items: Array<Pick<VaultFile, "id" | "folder_id" | "name" | "mime_type" | "size_bytes">> }>(
      "GET",
      `/orgs/${slug}/vault/record-documents?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
    ),
  /** A Vault document's bytes, fetched with the session (and so audited). */
  vaultFileBlob: async (slug: string, id: string, how: "open" | "download"): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`/api/v1/orgs/${slug}/vault/files/${id}/download${how === "open" ? "?inline=1" : ""}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(res.status, body?.error?.code ?? "vault_failed", body?.error?.message ?? "This document could not be opened.");
    }
    return res.blob();
  },
};
