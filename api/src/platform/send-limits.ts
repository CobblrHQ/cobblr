// How much one workspace may send people in an hour (#6528): invites that
// email someone, hand-offs of a person's things, test emails. Every door asks
// here (the People and Members screens, the Email screen, the assistant's
// actions), so a limit cannot be stepped around by picking another door.
// Counted from the activity log each send writes, so it holds across api
// processes and restarts. Over the limit is a refusal that says when more can
// go, never a silent drop.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { env } from "../env.js";

export type SendKind = "invite" | "hand_off" | "test_email";

const KINDS: Record<SendKind, { action: string; limit: () => number; words: string; onlyEmailed?: boolean }> = {
  invite: { action: "invite_created", limit: () => env.INVITES_PER_HOUR, words: "invites", onlyEmailed: true },
  hand_off: { action: "things_handed_off", limit: () => env.HAND_OFFS_PER_HOUR, words: "hand-offs" },
  test_email: { action: "outbound_email_tested", limit: () => env.TEST_EMAILS_PER_HOUR, words: "test emails" },
};

const HOUR_MS = 3_600_000;

/** Why this workspace may not send one more of `kind` now, or null. */
export async function sendLimitRefusal(orgId: string, kind: SendKind, now = new Date()): Promise<string | null> {
  const k = KINDS[kind];
  const limit = k.limit();
  const since = new Date(now.getTime() - HOUR_MS);
  let q = meta
    .selectFrom("activity_log")
    .select("occurred_at")
    .where("org_id", "=", orgId)
    .where("action", "=", k.action)
    .where("occurred_at", ">", since);
  // A join link nobody is emailed is not a send; only an invite with an
  // address goes out to a person.
  if (k.onlyEmailed) q = q.where(sql<boolean>`coalesce(diff->>'email', '') <> ''`);
  const rows = await q.orderBy("occurred_at", "desc").limit(limit).execute();
  if (rows.length < limit) return null;
  const oldest = rows[rows.length - 1]!.occurred_at;
  const minutes = Math.max(1, Math.ceil((oldest.getTime() + HOUR_MS - now.getTime()) / 60_000));
  return `This workspace has sent ${limit} ${k.words} in the last hour, its limit. You can send more in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
