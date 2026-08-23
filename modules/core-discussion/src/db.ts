// Kysely table types for core-discussion. Mirrors migrations/0001_init.sql.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface ConversationsTable {
  id: Generated<string>;
  source_module: string;
  /** Always the BASE kind — never an instance name (see normaliseKind). */
  source_type: string;
  source_id: string;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CommentsTable {
  id: Generated<string>;
  conversation_id: string;
  /** A reference to another comment, not a tree edge. */
  in_reply_to: string | null;
  author_kind: Generated<"user" | "assistant">;
  author_user_id: string | null;
  requested_by: string | null;
  status: Generated<"posted" | "pending" | "failed">;
  body: Generated<string>;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  created_at: Generated<Date>;
}

export interface MentionsTable {
  id: Generated<string>;
  comment_id: string;
  kind: "user" | "entity" | "assistant";
  user_id: string | null;
  target_module: string | null;
  target_type: string | null;
  target_id: string | null;
  created_at: Generated<Date>;
}

export interface ReadsTable {
  conversation_id: string;
  user_id: string;
  last_read_at: Generated<Date>;
}

export interface FollowsTable {
  source_module: string;
  source_type: string;
  source_id: string;
  user_id: string;
  reason: Generated<"commented" | "mentioned" | "explicit">;
  created_at: Generated<Date>;
}

export interface CoreDiscussionDB {
  core_discussion_conversations: ConversationsTable;
  core_discussion_comments: CommentsTable;
  core_discussion_mentions: MentionsTable;
  core_discussion_reads: ReadsTable;
  core_discussion_follows: FollowsTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<CoreDiscussionDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-discussion route called without tenant context");
  return t.db as Kysely<CoreDiscussionDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-discussion route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
