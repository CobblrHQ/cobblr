// /me/feedback — the reporter's own feedback, as two-way THREADS. Makes feedback
// a conversation (we can ask a clarifying question; they answer here) instead of
// fire-and-forget. Reads /feedback/mine; replies via /feedback/:id/reply. The
// notification we send on a reply deep-links here.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { api, type MyFeedbackItem } from "../lib/api";
import { QueryError } from "../components/QueryError";

const TYPE_EMOJI: Record<string, string> = { bug: "🐛", confusing: "😕", idea: "💡", other: "•" };
const STATUS_LABEL: Record<string, string> = {
  new: "Received",
  triaged: "Received",
  in_progress: "In progress",
  awaiting_decision: "In progress",
  backlog: "Planned",
  resolved: "Resolved",
  wontfix: "Closed",
};

export function MyFeedbackPage() {
  usePageTitle("Your feedback");
  const q = useQuery({ queryKey: ["my-feedback"], queryFn: () => api.listMyFeedback() });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4">
      {q.isLoading && <div className="text-sm text-faint">loading…</div>}
      {q.isError && (
        <QueryError what="your feedback" onRetry={() => q.refetch()} />
      )}
      {!q.isLoading && !q.isError && items.length === 0 && (
        <div className="text-sm text-faint italic">
          You haven't sent any feedback yet. Use the <b>Send feedback</b> button (bottom-right) anytime - 
          and you'll be able to follow the conversation here.
        </div>
      )}

      <ul className="space-y-3">
        {items.map((it) => (
          <FeedbackThread key={it.id} item={it} />
        ))}
      </ul>
    </div>
  );
}

function FeedbackThread({ item }: { item: MyFeedbackItem }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const reply = useMutation({
    mutationFn: (t: string) => api.replyToFeedback(item.id, t),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["my-feedback"] });
    },
  });
  const closed = item.status === "resolved" || item.status === "wontfix";
  function send() {
    const t = text.trim();
    if (t && !reply.isPending) reply.mutate(t);
  }
  return (
    <li className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span>{TYPE_EMOJI[item.type] ?? "•"}</span>
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted">
          {STATUS_LABEL[item.status] ?? item.status}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] font-mono text-faint">{new Date(item.created_at).toLocaleDateString()}</span>
      </div>

      <Bubble role="user" from="You" text={item.message} at={item.created_at} />
      {item.followups.map((f, i) => (
        <Bubble key={i} role={f.role ?? "user"} from={f.role === "team" ? "Cobblr" : "You"} text={f.text} at={f.at} />
      ))}

      <div className="flex gap-2 pt-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder={closed ? "Reply to reopen this…" : "Add a reply…"}
          className="input flex-1"
        />
        <button
          type="button"
          disabled={!text.trim() || reply.isPending}
          onClick={send}
          className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition disabled:opacity-50"
        >
          {reply.isPending ? "Sending…" : "Reply"}
        </button>
      </div>
    </li>
  );
}

function Bubble({ role, from, text, at }: { role: "user" | "team"; from: string; text: string; at: string }) {
  const team = role === "team";
  return (
    <div className={team ? "flex justify-start" : "flex justify-end"}>
      <div
        className={
          "max-w-[85%] rounded-lg px-3 py-2 text-sm " +
          (team ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100" : "bg-cobble-600 text-white")
        }
      >
        <div className={"text-[10px] font-mono uppercase tracking-widest mb-0.5 " + (team ? "text-accent" : "text-white/70")}>
          {from}
        </div>
        <div className="whitespace-pre-wrap break-words">{text}</div>
        <div className={"text-[9px] font-mono mt-1 " + (team ? "text-faint" : "text-white/60")}>
          {new Date(at).toLocaleString()}
        </div>
      </div>
    </div>
  );
}
