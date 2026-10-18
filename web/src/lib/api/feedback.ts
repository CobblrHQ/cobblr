import { request } from "./client";

/** A feedback item as the REPORTER sees it (no internal triage fields). */
export interface MyFeedbackItem {
  id: string;
  type: "bug" | "confusing" | "idea" | "use_case" | "other";
  /** Which chat server a discord-origin report came from, when configured. */
  origin_label?: string | null;
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
  followups: Array<{ at: string; from: string; text: string; role?: "user" | "team"; images?: Array<{ url: string; name?: string }> }>;
  attachments: Array<{ file_id: string; name?: string; content_type?: string }>;
  context: Record<string, unknown>;
}

export const feedbackApi = {
  submitFeedback: (body: {
    type: "bug" | "confusing" | "idea" | "use_case" | "other";
    message: string;
    /** A sandbox guest's chosen address: reachable through it (consent recorded). */
    contact_email?: string;
    workspace_slug?: string;
    context?: Record<string, unknown>;
    attachments?: Array<{ file_id: string; name?: string; content_type?: string }>;
  }) => request<{ id: string; created_at: string }>("POST", "/feedback", body),
  // The signed-in user's OWN feedback + their two-way threads (/me/feedback).
  listMyFeedback: (opts: { cursor?: string } = {}) => request<{ items: MyFeedbackItem[]; next_cursor: string | null; total: number }>("GET", `/feedback/mine${opts.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : ""}`),
  // The reporter replies to their own item (answers a clarifying question).
  replyToFeedback: (id: string, text: string) =>
    request<{ ok: boolean; reopened: boolean }>("POST", `/feedback/${encodeURIComponent(id)}/reply`, { text }),
};
