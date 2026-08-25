// Who may work a conversation, decided once so the tab and the inbox agree.
//
// The two dead UI states this file gates used to have no caller at all: the
// backend enforced "resolve is member and up" and "edit is your own comments
// only", but nothing in the web app ever called them, so the badges for both
// states were unreachable. These predicates are the client-side half of those
// two server rules, kept together so the resolve control on the tab and the one
// on the inbox row cannot gate themselves differently.

import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type { DiscussionComment } from "./api";

/** Resolve / reopen is a member-and-up action (matches the server's
 *  `requireRole(..., "owner", "admin", "member")` on POST /:id/resolve — read
 *  as "member or better" via the ranked contract). A guest may read a
 *  conversation but not settle it. */
export function canResolveConversation(role: string | null | undefined): boolean {
  return roleSatisfies(role, ["member"]);
}

/** You may edit only your OWN, live, human comment.
 *
 *  Mirrors the server: PATCH /:id is 403 unless `author_user_id === user.id`,
 *  404 on a tombstone, and Cobb's own posts are never editable (he writes new
 *  comments instead of rewriting old ones). A pending/failed row is not yet a
 *  real comment, so it is not editable either. */
export function canEditComment(
  comment: Pick<DiscussionComment, "author_kind" | "author_user_id" | "deleted_at" | "status">,
  selfUserId: string | null | undefined,
): boolean {
  if (!selfUserId) return false;
  return (
    comment.author_kind === "user" &&
    comment.author_user_id === selfUserId &&
    !comment.deleted_at &&
    comment.status === "posted"
  );
}
