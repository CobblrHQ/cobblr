// When a channel's messages arrive.
//
// The delivery-window feature shipped without a screen: the table, the policy,
// the sweeper and the REST route all existed, and the only way to set one was
// a PUT by hand. So nobody had one, and the reason the sweeper looked so cheap
// in production is that it had nothing to do.
//
// TWO CADENCES, because priority cannot separate the two things people want
// separated. A thread reply and "this expires today" are both `normal`, so any
// threshold that lets chat through lets the expiry through with it. What tells
// them apart is what caused them:
//
//   conversation — somebody did something. Live, usually.
//   due today    — a date arrived. One morning list, usually.
//
// Kept deliberately plain: two rows per channel, a time next to each. A screen
// about reducing noise should not itself be busy.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, MessageSquare, CalendarClock } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api, type DeliveryWindowRow } from "../lib/api";

/** Channels worth offering a cadence for. `in_app` is deliberately absent: the
 *  bell is a place you look, not a push, and the platform refuses to defer it. */
const CHANNELS: Array<{ key: string; label: string; hint: string; batchedOnly?: boolean }> = [
  { key: "discord_dm", label: "Discord DM", hint: "direct messages from Cobblr" },
  {
    key: "email",
    label: "Email",
    hint: "one message, however many workspaces",
    // Email is reached only when it is bounded to one message a day. Saying so
    // HERE matters: a cadence set to "as it happens" on email looks configured
    // and delivers nothing, which is the worst kind of setting.
    batchedOnly: true,
  },
];

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

const toMinute = (value: string): number => {
  const [h, m] = value.split(":");
  return Math.max(0, Math.min(1439, Number(h ?? 0) * 60 + Number(m ?? 0)));
};

/** The browser knows where the person is; asking them is a worse experience
 *  than a field they can correct if it is ever wrong. */
const guessZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const blank = (channel: string): DeliveryWindowRow => ({
  channel,
  mode: "immediate",
  deliver_at_minute: 480,
  timezone: guessZone(),
  last_delivered_at: null,
  schedule_mode: "inherit",
  schedule_deliver_at_minute: 480,
  schedule_last_delivered_at: null,
  pending_count: 0,
  pending_activity: 0,
  pending_schedule: 0,
});

export function DeliveryWindows() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["delivery-windows"],
    queryFn: () => api.meDeliveryWindows(),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.setMeDeliveryWindow>[0]) =>
      api.setMeDeliveryWindow(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["delivery-windows"] });
      toast.success("Saved.");
    },
    onError: () => toast.error("Couldn't save that."),
  });

  const byChannel = useMemo(() => {
    const m = new Map<string, DeliveryWindowRow>();
    for (const r of q.data?.items ?? []) m.set(r.channel, r);
    return m;
  }, [q.data]);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock size={15} className="text-accent" />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">
          When things arrive
        </h2>
      </div>
      <p className="text-sm text-muted dark:text-slate-400">
        Conversation can reach you as it happens while everything due today waits
        for one message in the morning. This is per person, not per workspace, so
        one daily message covers all of them.
      </p>

      {q.isLoading && <p className="text-xs text-faint">loading…</p>}

      {!q.isLoading && (
        <div className="space-y-3">
          {CHANNELS.map((c) => (
            <ChannelCadence
              key={c.key}
              channel={c}
              row={byChannel.get(c.key) ?? blank(c.key)}
              saving={save.isPending}
              onSave={(body) => save.mutate(body)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ChannelCadence({
  channel,
  row,
  saving,
  onSave,
}: {
  channel: { key: string; label: string; hint: string; batchedOnly?: boolean };
  row: DeliveryWindowRow;
  saving: boolean;
  onSave: (body: Parameters<typeof api.setMeDeliveryWindow>[0]) => void;
}) {
  const [draft, setDraft] = useState<DeliveryWindowRow>(row);
  // The saved row is the truth; a fresh one after saving replaces the draft.
  const [seen, setSeen] = useState(row);
  if (seen !== row) {
    setSeen(row);
    setDraft(row);
  }

  const dirty =
    draft.mode !== row.mode ||
    draft.deliver_at_minute !== row.deliver_at_minute ||
    draft.schedule_mode !== row.schedule_mode ||
    draft.schedule_deliver_at_minute !== row.schedule_deliver_at_minute;

  const commit = () =>
    onSave({
      channel: channel.key,
      mode: draft.mode,
      deliver_at_minute: draft.deliver_at_minute,
      timezone: draft.timezone,
      schedule_mode: draft.schedule_mode,
      schedule_deliver_at_minute: draft.schedule_deliver_at_minute,
    });

  return (
    <div className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-content dark:text-mortar-100">
          {channel.label}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
          {channel.hint}
        </span>
        {row.pending_count > 0 && (
          <span className="ml-auto text-[10px] font-mono uppercase tracking-widest text-amber-500">
            {row.pending_count} waiting
          </span>
        )}
      </div>

      <Cadence
        icon={<MessageSquare size={12} className="text-faint" />}
        label="Conversation"
        hint="replies, mentions, things that just happened"
        mode={draft.mode}
        modes={["immediate", "daily"]}
        minute={draft.deliver_at_minute}
        pending={row.pending_activity}
        onMode={(m) => setDraft({ ...draft, mode: m as "immediate" | "daily" })}
        onMinute={(v) => setDraft({ ...draft, deliver_at_minute: v })}
      />

      <Cadence
        icon={<CalendarClock size={12} className="text-faint" />}
        label="Due today"
        hint="expiring, service due, running low"
        mode={draft.schedule_mode}
        modes={["inherit", "immediate", "daily"]}
        minute={draft.schedule_deliver_at_minute}
        pending={row.pending_schedule}
        onMode={(m) =>
          setDraft({ ...draft, schedule_mode: m as "inherit" | "immediate" | "daily" })
        }
        onMinute={(v) => setDraft({ ...draft, schedule_deliver_at_minute: v })}
      />

      {channel.batchedOnly &&
        draft.mode !== "daily" &&
        draft.schedule_mode !== "daily" && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Email only carries a once-a-day message. Set one of these to "once a
            day" and it starts arriving; on "as it happens" it stays quiet.
          </p>
        )}

      <div className="flex items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
          {draft.timezone}
        </span>
        {dirty && (
          <button
            type="button"
            onClick={commit}
            disabled={saving}
            className="ml-auto rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-3 py-1.5 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}

const MODE_LABEL: Record<string, string> = {
  immediate: "as it happens",
  daily: "once a day at",
  inherit: "same as conversation",
};

function Cadence({
  icon,
  label,
  hint,
  mode,
  modes,
  minute,
  pending,
  onMode,
  onMinute,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  mode: string;
  modes: string[];
  minute: number;
  pending: number;
  onMode: (m: string) => void;
  onMinute: (v: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 min-w-[9rem]">
        {icon}
        <span className="text-xs text-content dark:text-mortar-200">{label}</span>
      </span>
      <select
        value={mode}
        onChange={(e) => onMode(e.target.value)}
        // w-auto: `.input` is w-full, which turns a row that should read
        // "Conversation | as it happens | replies, mentions" into four stacked
        // lines and doubles the height of every card.
        className="input w-auto text-xs px-2 py-1"
      >
        {modes.map((m) => (
          <option key={m} value={m}>
            {MODE_LABEL[m] ?? m}
          </option>
        ))}
      </select>
      {mode === "daily" && (
        <input
          type="time"
          value={hhmm(minute)}
          onChange={(e) => onMinute(toMinute(e.target.value))}
          className="input w-auto text-xs px-2 py-1"
        />
      )}
      <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
        {hint}
      </span>
      {pending > 0 && (
        <span className="text-[10px] font-mono uppercase tracking-widest text-amber-500">
          {pending} queued
        </span>
      )}
    </div>
  );
}
