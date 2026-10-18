import { request } from "./client";

export interface TagRecord {
  id: string;
  /** Custom fields a bundle or a person defines for tags. */
  metadata?: Record<string, unknown>;
  name: string;
  color: string | null;
  parent_id: string | null;
  icon: string | null;
  created_at: string;
  /** Pinned tags rank first and never fold behind "+N". */
  pinned?: boolean;
  /** Ranking, from core-tags src/relevance.ts. */
  uses?: number;
  last_used_at?: string | null;
  quiet?: boolean;
}

export interface TagAttachment {
  id: string;
  tag_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  role: string | null;
  created_at: string;
  // Joined on list:
  tag_name?: string;
  tag_color?: string | null;
  // Ranking, computed server-side so every surface agrees (core-tags
  // src/relevance.ts). `quiet` means old AND narrow — safe to fold behind
  // "+N"; `quiet_reason` is the sentence that says why.
  uses?: number;
  last_used_at?: string | null;
  pinned?: boolean;
  quiet?: boolean;
  quiet_reason?: string | null;
}

export const tagsApi = {

  // ─── core-tags ────────────────────────────────────────────────────
  listTags: (slug: string) =>
    request<{ items: TagRecord[] }>("GET", `/orgs/${slug}/modules/core-tags/tags`),
  createTag: (
    slug: string,
    body: { name: string; color?: string | null; parent_id?: string | null; icon?: string | null },
  ) => request<TagRecord>("POST", `/orgs/${slug}/modules/core-tags/tags`, body),
  updateTag: (
    slug: string,
    id: string,
    body: {
      name?: string;
      color?: string | null;
      parent_id?: string | null;
      icon?: string | null;
      pinned?: boolean;
      metadata?: Record<string, unknown>;
    },
  ) =>
    request<TagRecord>(
      "PATCH",
      `/orgs/${slug}/modules/core-tags/tags/${id}`,
      body,
    ),
  /** Takes the tag off every record carrying it; kept for 30 days so
   *  `restoreTag` can put it back. Owner or admin, or a grant. */
  deleteTag: (slug: string, id: string) =>
    request<{ deleted: true; name: string; assignments: number }>("DELETE", `/orgs/${slug}/modules/core-tags/tags/${id}`),
  /** Undo a tag delete or merge: the tag under its own id, on every record
   *  that carried it. */
  restoreTag: (slug: string, id: string) =>
    request<{ restored: true; name: string; assignments: number; mergedInto: string | null }>(
      "POST",
      `/orgs/${slug}/modules/core-tags/tags/deleted/${id}/restore`,
    ),
  mergeTag: (slug: string, id: string, intoTagId: string) =>
    request<{
      merged_into: TagRecord;
      moved_assignments: number;
      deleted_tag: { id: string; name: string };
    }>("POST", `/orgs/${slug}/modules/core-tags/tags/${id}/merge`, {
      into_tag_id: intoTagId,
    }),
  listTagAttachments: (
    slug: string,
    params:
      | { source_type: string; source_id: string; source_module?: string }
      | { tag_id: string },
  ) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return request<{ items: TagAttachment[] }>(
      "GET",
      `/orgs/${slug}/modules/core-tags/attachments?${qs}`,
    );
  },
  attachTag: (
    slug: string,
    body: {
      tag_name?: string;
      tag_id?: string;
      color?: string | null;
      source_module: string;
      source_type: string;
      source_id: string;
    },
  ) => request<TagAttachment>("POST", `/orgs/${slug}/modules/core-tags/attachments`, body),
  detachTag: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-tags/attachments/${id}`),
};
