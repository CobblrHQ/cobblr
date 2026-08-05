// The webhook URL for one announcement — a leaf module ON PURPOSE.
//
// announce.ts reaches db/meta -> env, and env calls process.exit(1) when the
// database vars are absent, so anything importing it is untestable without a
// DB. This is the one piece with real branching (which separator, which params),
// so it lives where a no-DB unit test can reach it.

/**
 * `wait=true` makes Discord echo the created message (id + channel_id) instead
 * of a bodyless 204. `thread_id` posts INSIDE an existing thread — how a
 * resolution lands under its own report instead of as a third top-level card
 * restating the same item.
 *
 * A configured webhook may already carry a query string, so the separator is
 * chosen rather than assumed.
 */
export function announceWebhookUrl(
  webhook: string,
  opts?: { wait?: boolean; threadId?: string | null },
): string {
  const qs: string[] = [];
  if (opts?.wait) qs.push("wait=true");
  if (opts?.threadId) qs.push(`thread_id=${encodeURIComponent(opts.threadId)}`);
  if (!qs.length) return webhook;
  return `${webhook}${webhook.includes("?") ? "&" : "?"}${qs.join("&")}`;
}
