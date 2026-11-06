// A reply answers something said in the same conversation. It is shown as a
// quote read from that conversation's own comments, so one pointing anywhere
// else reads "message removed" on arrival, and one pointing at nothing was a
// foreign-key failure answered as a server error.

import type { Kysely } from "kysely";
import type { CoreDiscussionDB } from "../db.js";

export const REPLY_ELSEWHERE = "That reply points at a comment that is not in this conversation.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function replyStaysInConversation(
  db: Kysely<CoreDiscussionDB>,
  source: { source_module: string; source_type: string; source_id: string },
  commentId: string,
): Promise<boolean> {
  if (!UUID.test(commentId)) return false;
  const found = await db
    .selectFrom("core_discussion_comments as c")
    .innerJoin("core_discussion_conversations as v", "v.id", "c.conversation_id")
    .select("c.id")
    .where("c.id", "=", commentId)
    .where("v.source_module", "=", source.source_module)
    .where("v.source_type", "=", source.source_type)
    .where("v.source_id", "=", source.source_id)
    .executeTakeFirst();
  return !!found;
}
