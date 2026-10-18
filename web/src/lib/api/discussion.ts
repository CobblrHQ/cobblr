import { walkPages } from "../list-pages";
import { request } from "./client";

/** A record's conversation. One per record; `resolved_at` is a bookmark
 *  meaning "decided", not a lock — posting into it opens it again. */
export interface DiscussionConversation {
  id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A Knowledge Base entry. `pinned` is what Quick Access reads. */
export interface KnowledgeEntry {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  pinned: boolean;
  /** An owned code, rendered as a barcode where a renderer is registered. */
  code: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DiscussionInboxItem {
  conversation_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  resolved_at: string | null;
  comments: number;
  latest_at: string | null;
  /** Newer than your last read of it — or never opened at all. */
  unread: boolean;
  /** Somebody named you in it. */
  addressed_to_me: boolean;
  following: boolean;
  follow_reason: string | null;
}

export interface DiscussionComment {
  id: string;
  /** A reference to another comment, not a tree edge. Ships unrendered. */
  in_reply_to: string | null;
  /** `guest`: someone outside the workspace, through a share; named by `author_name`. */
  author_kind: "user" | "assistant" | "guest";
  author_name?: string | null;
  /** An opaque id: these rows live in the tenant DB and users live in
   *  cobblr_meta, so names are resolved against the member list, never stored. */
  author_user_id: string | null;
  requested_by: string | null;
  status: "posted" | "pending" | "failed";
  body: string;
  edited_at: string | null;
  /** A tombstone. The row survives so a reply quoting it can say so; the body
   *  comes back empty. */
  deleted_at: string | null;
  created_at: string;
}

export const discussionApi = {

  // Members + invites
  // ── knowledge ───────────────────────────────────────────────────────────
  listKnowledgeEntries: (slug: string, opts?: { pinned?: boolean; kind?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.pinned) qs.set("pinned", "1");
    if (opts?.kind) qs.set("kind", opts.kind);
    if (opts?.q) qs.set("q", opts.q);
    // Every entry, not the first page: the route answers a page and the total.
    return walkPages<KnowledgeEntry>((offset, limit) => {
      const page = new URLSearchParams(qs);
      page.set("limit", String(limit));
      page.set("offset", String(offset));
      return request<{ items: KnowledgeEntry[]; total?: number | null; complete?: boolean }>(
        "GET",
        `/orgs/${slug}/modules/knowledge/entries?${page}`,
      );
    });
  },

  // ── discussion ──────────────────────────────────────────────────────────
  discussionInbox: (slug: string, q?: string, page: { offset: number; limit: number } = { offset: 0, limit: 500 }) =>
    request<{ items: DiscussionInboxItem[]; total?: number | null; complete?: boolean }>(
      "GET",
      `/orgs/${slug}/modules/core-discussion/comments/inbox?offset=${page.offset}&limit=${page.limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    ),
  markConversationRead: (
    slug: string,
    src: { source_module: string; source_type: string; source_id: string },
  ) =>
    request<void>("POST", `/orgs/${slug}/modules/core-discussion/comments/read`, src),
  followRecord: (
    slug: string,
    src: { source_module: string; source_type: string; source_id: string },
    following: boolean,
  ) =>
    request<{ following: boolean }>(
      "POST",
      `/orgs/${slug}/modules/core-discussion/comments/follow`,
      { ...src, following },
    ),
  getConversation: (
    slug: string,
    src: { source_module: string; source_type: string; source_id: string },
  ) =>
    request<{
      conversation: DiscussionConversation | null;
      comments: DiscussionComment[];
      count: number;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-discussion/comments?${new URLSearchParams(src).toString()}`,
    ),
  postComment: (
    slug: string,
    body: {
      source_module: string;
      source_type: string;
      source_id: string;
      body: string;
      in_reply_to?: string | null;
    },
  ) =>
    request<{ comment: DiscussionComment }>(
      "POST",
      `/orgs/${slug}/modules/core-discussion/comments`,
      body,
    ),
  editComment: (slug: string, id: string, body: string) =>
    request<{ comment: DiscussionComment }>(
      "PATCH",
      `/orgs/${slug}/modules/core-discussion/comments/${id}`,
      { body },
    ),
  deleteComment: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-discussion/comments/${id}`),
  resolveConversation: (slug: string, id: string, resolved: boolean) =>
    request<{ conversation: DiscussionConversation }>(
      "POST",
      `/orgs/${slug}/modules/core-discussion/comments/${id}/resolve`,
      { resolved },
    ),
};
