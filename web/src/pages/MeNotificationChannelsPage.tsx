// /me/notification-channels — manage per-workspace channel bindings.
//
// One table per workspace. Each row is a (event_type, channel,
// min_priority, enabled, config) tuple. Users add a binding for a
// channel, paste in the channel's config (webhook URL / SMTP creds
// / Twilio creds), pick a priority threshold, save.
//
// A "test" button fires a `test.notification` through every binding
// in the workspace at the chosen priority — proves the config
// works without waiting for a real event.

import { useState } from "react";
import { AreaTabs, NOTIFICATION_TABS } from "../components/AreaTabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Plus, Send, Trash2, Zap } from "lucide-react";
import {
  Modal,
  useConfirm,
  usePageTitle,
  useToast,
} from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import {
  ApiError,
  api,
  type NotificationChannelBinding,
  type NotificationChannelName,
  type NotificationPriority,
} from "../lib/api";

const PRIORITIES: NotificationPriority[] = ["low", "normal", "high", "urgent"];

const CHANNEL_OPTIONS: Array<{
  channel: NotificationChannelName;
  label: string;
  hint: string;
  /** Fields the user fills in for this channel. */
  fields: Array<{
    key: string;
    label: string;
    type?: "text" | "password" | "number" | "url" | "select" | "checkbox";
    placeholder?: string;
    helpText?: string;
    /** For type:"select". */
    options?: Array<{ value: string; label: string }>;
    /** Default value (used by select; also the assumed value when deciding
     *  showIf visibility before the user touches the field). */
    default?: string;
    /** Only show this field when another field's value is one of these. */
    showIf?: { key: string; in: string[] };
  }>;
}> = [
  {
    channel: "in_app",
    label: "In-app",
    hint: "The bell badge + /me/notifications inbox. Notifications go here by default; add a row with enabled=off to MUTE in-app for a specific event_type.",
    fields: [],
  },
  {
    channel: "browser_push",
    label: "Browser push",
    hint: "Service-worker push notifications (stubbed for now. See backlog). Add a row to opt-in once VAPID keys are wired up.",
    fields: [],
  },
  {
    channel: "discord",
    label: "Discord",
    hint: "Server-side incoming webhook. Right-click the channel → Edit Channel → Integrations → Webhooks.",
    fields: [
      {
        key: "webhook_url",
        label: "Webhook URL",
        type: "url",
        placeholder: "https://discord.com/api/webhooks/<id>/<token>",
      },
    ],
  },
  {
    channel: "slack",
    label: "Slack",
    hint: "Incoming webhook for a channel. App config → Incoming Webhooks → Add to workspace.",
    fields: [
      {
        key: "webhook_url",
        label: "Webhook URL",
        type: "url",
        placeholder: "https://hooks.slack.com/services/<workspace>/<channel>/<token>",
      },
    ],
  },
  {
    channel: "webhook",
    label: "Generic webhook",
    hint: "POST the JSON envelope to your own URL. The body shape is documented.",
    fields: [
      {
        key: "url",
        label: "URL",
        type: "url",
        placeholder: "https://example.com/cobblr-hooks",
      },
    ],
  },
  {
    channel: "email",
    label: "Email",
    hint: "Bring your own delivery. Pick a provider and paste its creds. Cobblr doesn't host an outbound mail server.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "smtp",
        options: [
          { value: "smtp", label: "SMTP (Gmail, Fastmail, SES SMTP, …)" },
          { value: "mailgun", label: "Mailgun (HTTP API)" },
          { value: "resend", label: "Resend (HTTP API)" },
          { value: "postmark", label: "Postmark (HTTP API)" },
        ],
      },
      { key: "from", label: "From", placeholder: "cobblr@example.com" },
      { key: "to", label: "Send to", placeholder: "you@example.com" },
      // SMTP
      { key: "smtp_host", label: "SMTP host", placeholder: "smtp.gmail.com", showIf: { key: "provider", in: ["smtp"] } },
      { key: "smtp_port", label: "Port", type: "number", placeholder: "465", helpText: "465 = TLS, 587 = STARTTLS", showIf: { key: "provider", in: ["smtp"] } },
      { key: "smtp_user", label: "Username", placeholder: "you@example.com", showIf: { key: "provider", in: ["smtp"] } },
      { key: "smtp_pass", label: "Password / app password", type: "password", helpText: "Gmail: an App Password (needs 2FA), not your account password. Free Gmail caps ~500/day.", showIf: { key: "provider", in: ["smtp"] } },
      // Mailgun
      { key: "mailgun_api_key", label: "Mailgun API key", type: "password", showIf: { key: "provider", in: ["mailgun"] } },
      { key: "mailgun_domain", label: "Mailgun domain", placeholder: "mg.example.com", showIf: { key: "provider", in: ["mailgun"] } },
      { key: "mailgun_eu", label: "EU region", type: "checkbox", helpText: "Tick if your Mailgun account is in the EU region.", showIf: { key: "provider", in: ["mailgun"] } },
      // Resend
      { key: "resend_api_key", label: "Resend API key", type: "password", placeholder: "re_…", showIf: { key: "provider", in: ["resend"] } },
      // Postmark
      { key: "postmark_token", label: "Postmark server token", type: "password", showIf: { key: "provider", in: ["postmark"] } },
    ],
  },
  {
    channel: "sms",
    label: "SMS (Twilio)",
    hint: "Sends via your Twilio account. Account SID + auth token from the Twilio console.",
    fields: [
      { key: "account_sid", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      { key: "auth_token", label: "Auth token", type: "password" },
      { key: "from_number", label: "From (E.164)", placeholder: "+15551234567" },
      { key: "to_number", label: "To (E.164)", placeholder: "+15559876543" },
    ],
  },
];

export function MeNotificationChannelsPage() {
  usePageTitle("Notification channels");
  const { orgs } = useAuth();
  const [activeOrgId, setActiveOrgId] = useState<string>(
    () => orgs[0]?.id ?? "",
  );

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <AreaTabs tabs={NOTIFICATION_TABS} area="notifications" />
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Bell size={20} className="text-accent" />
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          notification channels
        </h1>
      </div>

      <p className="text-sm text-content dark:text-mortar-200">
        Send Cobblr events to Discord, Slack, your email, SMS, or any
        webhook. Each binding picks a channel, an event type (or{" "}
        <code className="font-mono text-xs">*</code> for all events),
        and a minimum priority - so you can wire{" "}
        <code className="font-mono text-xs">urgent</code> events to
        SMS while routine{" "}
        <code className="font-mono text-xs">normal</code>{" "}
        notifications go to email.
      </p>

      {orgs.length === 0 ? (
        <div className="text-sm text-faint">No workspaces.</div>
      ) : (
        <>
          {orgs.length > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono uppercase tracking-widest text-accent">
                workspace:
              </span>
              <select
                value={activeOrgId}
                onChange={(e) => setActiveOrgId(e.target.value)}
                className="input text-xs px-2 py-1"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {activeOrgId && <WorkspaceBindings orgId={activeOrgId} />}
        </>
      )}
    </div>
  );
}

function WorkspaceBindings({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  const q = useQuery({
    queryKey: ["notification-channels", orgId],
    queryFn: () => api.meNotificationChannels(orgId),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMeNotificationChannel(id),
    onSuccess: () => {
      toast.success("Binding removed.");
      void qc.invalidateQueries({ queryKey: ["notification-channels", orgId] });
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove."),
  });

  const test = useMutation({
    mutationFn: (priority: NotificationPriority) =>
      api.testMeNotificationChannel({ org_id: orgId, priority }),
    onSuccess: (r) => {
      if (r.deliveredVia.length === 0) {
        toast.error("Test sent but no channel reported delivery.");
      } else {
        // Shorter dismiss than the default 5s — the toast is purely
        // confirmation of a transient probe; sticking around as long
        // as a destructive-action toast made the UI feel cluttered
        // during back-to-back tests.
        toast.success(`Delivered via ${r.deliveredVia.join(", ")}.`, {
          duration: 2500,
        });
      }
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Test failed."),
  });

  const testOne = useMutation({
    mutationFn: (args: { id: string; priority: NotificationPriority }) =>
      api.testOneMeNotificationChannel(args.id, { priority: args.priority }),
    onSuccess: (r, args) => {
      if (r.deliveredVia.length === 0) {
        toast.error(
          `Test at priority=${args.priority} didn't deliver — check config or threshold.`,
        );
      } else {
        toast.success(`Delivered via ${r.deliveredVia.join(", ")}.`, {
          duration: 2500,
        });
      }
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Test failed."),
  });

  async function handleRemove(b: NotificationChannelBinding) {
    const ok = await confirm({
      title: `Remove ${b.channel} binding?`,
      message: `Stops sending '${b.event_type}' events to this channel. The config (secrets included) will be deleted.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) remove.mutate(b.id);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5 transition"
        >
          <Plus size={11} /> Add binding
        </button>
        <div className="ml-auto flex items-center gap-1">
          <span
            className="text-[10px] font-mono uppercase tracking-widest text-faint"
            title="Fires a test.notification through EVERY binding in this workspace at the chosen priority. Use the per-row test button to fire one binding in isolation."
          >
            test all:
          </span>
          {PRIORITIES.map((p) => (
            <button
              key={p}
              onClick={() => test.mutate(p)}
              disabled={test.isPending}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-line dark:border-slate-700 text-muted hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-50"
              title={`Fire a test.notification through every binding at priority=${p}`}
            >
              {p === "urgent" && <Zap size={9} className="inline -mt-0.5" />} {p}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading && <div className="text-sm text-faint">Loading…</div>}
      {q.isError && (
        <div className="text-sm text-ember-500">
          {q.error instanceof ApiError
            ? q.error.message
            : "Couldn't load bindings."}
        </div>
      )}

      {q.data && q.data.items.length === 0 && (
        <div className="text-xs text-faint italic px-1 py-3">
          No channel bindings yet. By default, every notification lands
          in your in-app inbox; add a binding above to also send to
          Discord, Slack, email, SMS, or a webhook.
        </div>
      )}

      {q.data && q.data.items.length > 0 && (
        <div className="border border-line dark:border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-subtle dark:bg-slate-800/50 text-[10px] font-mono uppercase tracking-widest text-faint">
              <tr>
                <th className="text-left px-3 py-2">Channel</th>
                <th className="text-left px-3 py-2">Event</th>
                <th className="text-left px-3 py-2">Min priority</th>
                <th className="text-left px-3 py-2">Enabled</th>
                <th className="text-left px-3 py-2">Config</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line dark:divide-slate-800">
              {q.data.items.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-2 font-mono">{b.channel}</td>
                  <td className="px-3 py-2 font-mono">
                    {b.event_type === "*" ? (
                      <span className="text-accent">(all events)</span>
                    ) : (
                      b.event_type
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <PriorityBadge priority={b.min_priority} />
                  </td>
                  <td className="px-3 py-2">
                    {b.enabled ? (
                      <span className="text-moss-600">on</span>
                    ) : (
                      <span className="text-faint">off</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-muted truncate max-w-xs">
                    {summarizeConfig(b.config)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() =>
                          testOne.mutate({ id: b.id, priority: b.min_priority })
                        }
                        disabled={testOne.isPending}
                        className="text-accent hover:text-accent transition disabled:opacity-50"
                        title={`Send a test notification through THIS binding at priority=${b.min_priority} (its threshold)`}
                      >
                        <Send size={12} />
                      </button>
                      <button
                        onClick={() => handleRemove(b)}
                        className="text-ember-500 hover:text-ember-600 transition"
                        title="Remove binding"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && (
        <AddBindingModal
          orgId={orgId}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void qc.invalidateQueries({
              queryKey: ["notification-channels", orgId],
            });
          }}
        />
      )}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: NotificationPriority }) {
  const styles: Record<NotificationPriority, string> = {
    low: "bg-subtle dark:bg-slate-800 text-muted",
    normal: "bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300",
    high: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300",
    urgent: "bg-ember-100 dark:bg-ember-900/30 text-ember-700 dark:text-ember-300",
  };
  return (
    <span
      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${styles[priority]}`}
    >
      {priority}
    </span>
  );
}

type ChannelDef = (typeof CHANNEL_OPTIONS)[number];
type FieldDef = ChannelDef["fields"][number];

/** A field's effective value: what the user typed, else its default. */
function depValue(def: ChannelDef, config: Record<string, string>, key: string): string {
  return config[key] ?? def.fields.find((x) => x.key === key)?.default ?? "";
}

/** Fields to show given the current config (resolves showIf against defaults). */
function visibleFields(def: ChannelDef, config: Record<string, string>): FieldDef[] {
  return def.fields.filter(
    (f) => !f.showIf || f.showIf.in.includes(depValue(def, config, f.showIf.key)),
  );
}

function summarizeConfig(config: Record<string, unknown> | null): string {
  if (!config) return "—";
  const keys = Object.keys(config);
  if (keys.length === 0) return "—";
  return keys
    .map((k) => {
      const v = config[k];
      if (v === "<set>") return `${k}=<set>`;
      if (typeof v === "string" && v.length > 30) return `${k}=${v.slice(0, 30)}…`;
      return `${k}=${v}`;
    })
    .join(", ");
}

function AddBindingModal({
  orgId,
  onClose,
  onSaved,
}: {
  orgId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [channel, setChannel] = useState<NotificationChannelName>("discord");
  const [eventType, setEventType] = useState<string>("*");
  const [minPriority, setMinPriority] = useState<NotificationPriority>("normal");
  const [enabled, setEnabled] = useState(true);
  const [config, setConfig] = useState<Record<string, string>>({});

  const channelDef = CHANNEL_OPTIONS.find((c) => c.channel === channel)!;

  const save = useMutation({
    mutationFn: () => {
      // Coerce number fields. The api validates by zod so a string
      // "465" would fail smtp_port (z.number().int()) — coerce on
      // the way out.
      const finalConfig: Record<string, unknown> = {};
      // Only persist fields visible for the chosen provider, so switching
      // provider doesn't leak stale creds from another one.
      for (const f of visibleFields(channelDef, config)) {
        if (f.type === "checkbox") {
          if (config[f.key] === "true") finalConfig[f.key] = true;
          continue;
        }
        let raw = config[f.key];
        if ((raw === undefined || raw === "") && f.default !== undefined) raw = f.default;
        if (raw === undefined || raw === "") continue;
        finalConfig[f.key] = f.type === "number" ? Number(raw) : raw;
      }
      return api.upsertMeNotificationChannel({
        org_id: orgId,
        event_type: eventType.trim() || "*",
        channel,
        enabled,
        min_priority: minPriority,
        config: finalConfig,
      });
    },
    onSuccess: () => {
      toast.success("Binding saved.");
      onSaved();
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.message : "Save failed."),
  });

  return (
    <Modal open onClose={onClose} title="Add notification binding" size="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Channel">
            <select
              className="input"
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value as NotificationChannelName);
                setConfig({});
              }}
            >
              {/* All channels including in_app/browser_push — users can
                  add an in_app row with enabled=off to mute a specific
                  event_type. The hint copy spells that out. */}
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c.channel} value={c.channel}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Event type">
            <input
              className="input"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="* for all"
            />
          </Field>
          <Field label="Min priority">
            <select
              className="input"
              value={minPriority}
              onChange={(e) =>
                setMinPriority(e.target.value as NotificationPriority)
              }
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Enabled">
            <label className="flex items-center gap-2 text-xs h-9">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>{enabled ? "fires" : "paused"}</span>
            </label>
          </Field>
        </div>

        <div className="text-xs text-muted dark:text-slate-400 italic">
          {channelDef.hint}
        </div>

        {channelDef.fields.length > 0 && (
          <div className="space-y-2 border-t border-line dark:border-slate-700 pt-3">
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
              // {channelDef.label.toLowerCase()} config
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {visibleFields(channelDef, config).map((f) => (
                <Field key={f.key} label={f.label}>
                  {f.type === "select" ? (
                    <select
                      className="input"
                      value={config[f.key] ?? f.default ?? ""}
                      onChange={(e) => setConfig((p) => ({ ...p, [f.key]: e.target.value }))}
                    >
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "checkbox" ? (
                    <label className="flex items-center gap-2 text-xs h-9">
                      <input
                        type="checkbox"
                        checked={config[f.key] === "true"}
                        onChange={(e) =>
                          setConfig((p) => ({ ...p, [f.key]: e.target.checked ? "true" : "" }))
                        }
                      />
                      <span>{config[f.key] === "true" ? "yes" : "no"}</span>
                    </label>
                  ) : (
                    <input
                      className="input"
                      type={f.type ?? "text"}
                      value={config[f.key] ?? ""}
                      onChange={(e) => setConfig((p) => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                    />
                  )}
                  {f.helpText && (
                    <div className="text-[10px] text-faint mt-0.5">
                      {f.helpText}
                    </div>
                  )}
                </Field>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-4 py-2 transition disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onClose}
            className="text-xs text-muted hover:text-content px-3"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
