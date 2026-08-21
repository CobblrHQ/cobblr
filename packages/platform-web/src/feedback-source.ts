// The seam that lets ONE triage UI serve two hosts.
//
// The operator console's feedback tab is the good triage interface, and it is welded to
// this instance: it imports the api client directly, so the same component cannot render
// another deployment's queue. That is why the ops hub ended up with a second, worse copy
// of it — twice.
//
// The fix is not to copy it again. It is to give the component a small interface over
// "where do items come from and what can I do to them", and let each host supply one:
//
//   • an instance passes a source backed by its own /super-admin/feedback
//   • the ops hub passes a source backed by its cross-instance mirror
//
// Nothing here reaches for a transport, a query client or a toast. That keeps the
// component testable without a server, and keeps the hub from needing an instance's
// credentials — the mistake that closed core #1844.
//
// See docs/design-decisions/operator-console-split.md for which surfaces move and why.

/** One report, in the shape every host already returns. `instance*` is present only when
 *  the item arrived through the cross-instance hub; an instance's own queue omits it,
 *  which is how the card knows whether it may act on the item. */
export interface FeedbackSourceItem {
  id: string;
  type: string;
  message: string;
  status: string;
  context: Record<string, unknown>;
  admin_notes: string | null;
  origin: string;
  origin_ref: { thread_id?: string; username?: string } | null;
  followups: Array<{ at: string; from: string; text: string; role?: string }>;
  /** Per-channel outcome of the last reply we sent this reporter. Null on an
   *  item nobody has replied to (or one replied to before we recorded it). */
  reply_delivery?: Partial<Record<"in_app" | "email" | "discord_dm", string>> | null;
  attachments: Array<{ file_id: string; name?: string; content_type?: string }>;
  triage_priority: "urgent" | "high" | "medium" | "low" | null;
  triage_summary: string | null;
  triage_action: string | null;
  triaged_at: string | null;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
  workspace_slug: string | null;
  workspace_name: string | null;
  instance?: string;
  instance_label?: string;
  instance_base?: string;
}

export interface FeedbackUpdate {
  status?: string;
  admin_notes?: string | null;
  notify_reporter?: boolean;
  reply_message?: string;
  public_summary?: string;
}

/** What a host must provide. Deliberately four members: anything more and a host starts
 *  having to fake capabilities it does not have. */
export interface FeedbackSource {
  /** A label for the switcher. */
  readonly name: string;
  list(opts: { status?: string; sort?: "priority" | "recent" }): Promise<{
    items: FeedbackSourceItem[];
    /** Per-instance sync state, hub only. A host that owns its data returns nothing, and
     *  the UI shows no staleness banner. */
    instances?: Record<string, { ok: boolean; at: string | null; error: string | null }>;
  }>;
  /** Absent = this source is read-only, and the UI hides the controls rather than
   *  offering ones that would fail. The hub is read-only until writes proxy back to the
   *  owning instance; a reply control that silently PATCHed the wrong deployment would
   *  be worse than one that is not there. */
  update?(item: FeedbackSourceItem, body: FeedbackUpdate): Promise<{ notified?: boolean; emailed?: boolean }>;
  /** A URL the browser can load for a reporter's screenshot, or null when this host
   *  cannot serve it (the hub does not proxy tenant files). */
  imageUrl(item: FeedbackSourceItem, fileId: string, variant?: "thumb" | "medium"): string | null;
}

/** True when the item belongs to a different deployment than the host rendering it, so
 *  acting on it here would PATCH the wrong database. Pure, and the one rule the card
 *  needs to decide between controls and a link. */
export function isForeign(item: FeedbackSourceItem): boolean {
  return !!item.instance;
}

/** Highest-priority first, then newest. Both hosts sort the same way, so the order stops
 *  being a property of whichever backend answered. */
export function byPriorityThenRecent(a: FeedbackSourceItem, b: FeedbackSourceItem): number {
  const rank = { urgent: 1, high: 2, medium: 3, low: 4 } as const;
  const pa = a.triage_priority ? rank[a.triage_priority] : 5;
  const pb = b.triage_priority ? rank[b.triage_priority] : 5;
  return pa !== pb ? pa - pb : String(b.created_at).localeCompare(String(a.created_at));
}
