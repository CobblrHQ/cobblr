// One line of the integrations call log. A send that gave up says why and
// carries the button to send it again; one that is still trying says so and
// offers nothing, because it will go by itself.

import { relativeTime } from "@cobblr/platform-web";
import type { IntegrationCall } from "../lib/api";

export function IntegrationCallRow({ call: c, onSendAgain, sending }: { call: IntegrationCall; onSendAgain: (callId: string) => void; sending: boolean }) {
  const meta = (c.request_meta ?? {}) as { attempt?: number; gave_up?: boolean; needs_look?: boolean; retry_at?: string; resent_at?: string };
  const retrying = !c.ok && !!meta.retry_at;
  const canSendAgain = c.direction === "outbound" && !c.ok && !!meta.gave_up && !meta.resent_at;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={c.ok ? "text-emerald-600 dark:text-emerald-400" : retrying ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}>{c.ok ? "ok" : retrying ? "retry" : "err"}</span>
      <span className="text-muted">{c.direction}</span>
      <span className="font-medium">{c.connector_id}</span>
      <span className="text-muted">{c.action_or_event}</span>
      <span className="text-faint">
        {c.status ?? "—"} · {c.ms ?? "—"}ms
      </span>
      <span className="text-faint">{new Date(c.occurred_at).toLocaleString()}</span>
      {c.error && <span className="text-red-500 break-words min-w-0">{c.error}</span>}
      {retrying && <span className="text-amber-600 dark:text-amber-400">Trying again {relativeTime(meta.retry_at!)}</span>}
      {!c.ok && meta.needs_look && <span className="text-amber-600 dark:text-amber-400">May already have arrived. Check before sending again.</span>}
      {!c.ok && meta.gave_up && !meta.needs_look && (meta.attempt ?? 1) > 1 && <span className="text-faint">Gave up after {meta.attempt} tries</span>}
      {!c.ok && meta.gave_up && !meta.needs_look && (meta.attempt ?? 1) <= 1 && <span className="text-faint">Not delivered</span>}
      {meta.resent_at && <span className="text-faint">Sent again</span>}
      {canSendAgain && (
        <button
          type="button"
          disabled={sending}
          onClick={() => onSendAgain(c.id)}
          className="min-h-[44px] px-3 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send again"}
        </button>
      )}
    </div>
  );
}
