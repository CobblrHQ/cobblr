// One feedback item, one Discord card, edited as the item moves.
//
// It used to be a card per stage: "New feedback" when reported, "Feedback
// resolved" when shipped, emoji reactions in between, and for Discord-origin
// tickets the two never even linked (the report path did not remember its
// message id). The operator asked for one message that changes state
// (2026-09-07). This is what that message says at each state — pure, so every
// state can be asserted, and so the two places that post or edit it cannot
// drift from each other.

export interface FeedbackCardRow {
  type: string | null;
  status: string | null;
  message: string | null;
  admin_notes?: string | null;
  triage_summary?: string | null;
  announce_message_id?: string | null;
}

export interface FeedbackCardPayload {
  title: string;
  body: string;
  color: number;
}

const KIND: Record<string, { emoji: string; label: string }> = {
  bug: { emoji: "🐛", label: "bug report" },
  confusing: { emoji: "😕", label: "confusing-UX report" },
  idea: { emoji: "💡", label: "idea" },
  use_case: { emoji: "🧭", label: "use case" },
  other: { emoji: "💬", label: "feedback" },
};

const BLUE = 0x5865f2, AMBER = 0xfaa61a, GREY = 0x4f545c, GREEN = 0x2e7d32;

function prNumber(notes: string | null | undefined): string | null {
  const m = /autopilot PR #(\d+)/i.exec(notes ?? "");
  return m ? m[1]! : null;
}

/** What the card says for a row in its current state. `fixed` is the
 *  third-person "what we did" line, present only on resolve. */
export function feedbackCard(row: FeedbackCardRow, opts: { fixed?: string | null } = {}): FeedbackCardPayload {
  const k = KIND[row.type ?? "other"] ?? KIND.other!;
  const reported = (row.message ?? "").slice(0, 1200);
  const status = row.status ?? "new";
  const pr = prNumber(row.admin_notes);

  switch (status) {
    case "resolved": {
      const fixed = (opts.fixed ?? "").trim();
      return {
        title: `✅ ${k.label} · resolved`,
        body: fixed ? `**Reported:** ${reported}\n\n**Fixed:** ${fixed.slice(0, 2400)}` : reported,
        color: GREEN,
      };
    }
    case "wontfix":
      return { title: `🚫 ${k.label} · not planned`, body: reported, color: GREY };
    case "backlog":
      return { title: `📥 ${k.label} · backlog`, body: reported, color: GREY };
    case "awaiting_decision":
      return { title: `📋 ${k.label} · awaiting a decision`, body: reported, color: AMBER };
    case "in_progress":
      return {
        title: `🔨 ${k.label} · in progress${pr ? ` (PR #${pr})` : ""}`,
        body: reported,
        color: AMBER,
      };
    case "triaged": {
      const summary = (row.triage_summary ?? "").trim();
      return {
        title: `🔎 ${k.label} · triaged`,
        body: summary ? `${reported}\n\n**Triage:** ${summary.slice(0, 600)}` : reported,
        color: BLUE,
      };
    }
    default:
      return { title: `${k.emoji} New ${k.label}`, body: reported, color: BLUE };
  }
}

/** Whether a resolution is an EDIT of the item's own card or a fresh post.
 *  Fresh only when there is no card to edit — an item reported before the
 *  message id was captured, or one whose post never landed. */
export function resolutionDelivery(row: { announce_message_id?: string | null }): "edit" | "post" {
  return row.announce_message_id ? "edit" : "post";
}
