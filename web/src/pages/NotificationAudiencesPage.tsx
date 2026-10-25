// /configuration/notification-audiences — who each kind of workspace
// notification is for.
//
// Every workspace-wide notification reached every member, and a household
// with a guest in it told the guest what was going off in the fridge
// (2026-09-07). Channel bindings under Your account decide HOW a person is
// told; this page decides WHETHER they are one of the people to tell, per
// kind: everyone, the owners only, or specific people.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { OnceQuiet, SegmentedChoice, usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ContributedConfigSections } from "../panels/registry";
import { api, ApiError, type NotificationAudienceKind, type NotificationAudienceMode, type NotificationDefaultChannel, type WorkspaceMember } from "../lib/api";

const MODES: Array<{ mode: NotificationAudienceMode; label: string }> = [
  { mode: "all", label: "Everyone" },
  { mode: "owners", label: "Owners only" },
  { mode: "custom", label: "Specific people" },
];

export function NotificationAudiencesPage() {
  usePageTitle("Who gets told");
  const { activeSlug, activeOrg } = useActiveOrg();
  // role-gate: exact — who is told what is governance; mirrors the server's
  // exact gate on /notification-audiences.
  const canEdit = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const kinds = useQuery({
    queryKey: ["notification-audiences", activeSlug],
    queryFn: () => api.listNotificationAudiences(activeSlug),
    enabled: !!activeSlug,
  });
  const orgModules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
  });
  const members = useQuery({
    queryKey: ["members", activeSlug],
    queryFn: () => api.listMembers(activeSlug),
    enabled: !!activeSlug,
  });

  if (!canEdit) {
    return <p className="text-sm text-faint">Workspace owners and admins decide who is told what.</p>;
  }

  const byModule = new Map<string, NotificationAudienceKind[]>();
  for (const k of kinds.data?.items ?? []) {
    const list = byModule.get(k.module) ?? [];
    list.push(k);
    byModule.set(k.module, list);
  }

  return (
    // The defaults, a module's own section and each kind's audience fill in
    // from their own answers: drawn together, so none pushes an audience's
    // buttons down under a finger (#6881).
    <OnceQuiet className="space-y-5">
      <DefaultChannels slug={activeSlug} />
      <p className="text-sm text-faint dark:text-slate-400">
        Each kind of notification this workspace sends, and who it goes to. Everyone is the default. How
        each person is told (the bell, a Discord DM, email) is their own choice under Your account.
      </p>
      {kinds.data && kinds.data.items.length === 0 && (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm text-faint">
          Nothing to route yet. Kinds appear here as modules that send notifications are enabled, and as the
          first of each kind arrives.
        </div>
      )}
      <ContributedConfigSections
        target="notification-audiences"
        panels={(orgModules.data?.items ?? []).filter((m) => m.enabled).flatMap((m) => m.panels ?? [])}
        ctx={{ slug: activeSlug }}
      />
      {[...byModule.entries()].map(([module, items]) => (
        <section key={module} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-4">
          <h2 className="text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">{module}</h2>
          {items.map((k) => (
            <KindRow key={k.event_type} slug={activeSlug} kind={k} members={members.data?.items ?? []} />
          ))}
        </section>
      ))}
    </OnceQuiet>
  );
}

const DEFAULT_OPTIONS: Array<{ value: NotificationDefaultChannel | "none"; label: string }> = [
  { value: "none", label: "The bell alone" },
  { value: "email", label: "Email" },
  { value: "discord_dm", label: "Discord (for members who connected it)" },
  { value: "browser_push", label: "Phone and computer notifications" },
];

/** How members who have not chosen for themselves hear this workspace's urgent
 *  and high events (#6909). A member who set any channel here keeps their own. */
function DefaultChannels({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const defaults = useQuery({ queryKey: ["notification-defaults", slug], queryFn: () => api.notificationDefaults(slug), enabled: !!slug });
  const save = useMutation({
    mutationFn: ({ priority, channel }: { priority: "urgent" | "high"; channel: NotificationDefaultChannel | null }) => api.setNotificationDefault(slug, priority, channel),
    onSuccess: (data, { priority, channel }) => {
      qc.setQueryData(["notification-defaults", slug], data);
      const how = DEFAULT_OPTIONS.find((o) => o.value === (channel ?? "none"))!.label.split(" (")[0]!.toLowerCase();
      toast.success(`Members who have not chosen now hear ${priority} events by ${how}.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save that. Try again."),
  });
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3" data-testid="notification-defaults">
      <h2 className="text-sm font-semibold text-content dark:text-slate-200">How members hear urgent and high events</h2>
      <p className="text-sm text-faint dark:text-slate-400">
        For members who have not chosen a channel in this workspace yet. Anyone who sets their own keeps it, and a channel
        they turned off stays off. Everyone still sees everything in the bell.
      </p>
      {(["urgent", "high"] as const).map((priority) => (
        <label key={priority} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-content dark:text-slate-200">{priority === "urgent" ? "Urgent events" : "High priority events"}</span>
          <select
            aria-label={priority === "urgent" ? "How members hear urgent events" : "How members hear high priority events"}
            className="rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 px-2 py-1.5 text-sm max-w-full"
            value={defaults.data?.[priority] ?? "none"}
            disabled={!defaults.data || save.isPending}
            onChange={(e) => save.mutate({ priority, channel: e.target.value === "none" ? null : (e.target.value as NotificationDefaultChannel) })}
          >
            {DEFAULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </section>
  );
}

function KindRow({ slug, kind, members }: { slug: string; kind: NotificationAudienceKind; members: WorkspaceMember[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set(kind.user_ids));
  const [mode, setMode] = useState<NotificationAudienceMode>(kind.mode);
  const save = useMutation({
    mutationFn: (body: { mode: NotificationAudienceMode; user_ids?: string[] }) => api.setNotificationAudience(slug, kind.event_type, body),
    onSuccess: () => {
      toast.success(`${kind.label}: saved`);
      void qc.invalidateQueries({ queryKey: ["notification-audiences", slug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const choose = (m: NotificationAudienceMode) => {
    setMode(m);
    // Everyone and owners save at once; specific people saves when at least
    // one person is ticked, so a half-made list never routes to nobody.
    if (m !== "custom") save.mutate({ mode: m });
    else if (picked.size > 0) save.mutate({ mode: m, user_ids: [...picked] });
  };
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    if (next.size > 0) save.mutate({ mode: "custom", user_ids: [...next] });
  };
  const owners = members.filter((m) => m.role === "owner").length;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <Users size={16} className="mt-0.5 shrink-0 text-accent dark:text-cobble-300" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-content dark:text-mortar-100">{kind.label}</div>
          {kind.description && <p className="text-xs text-faint dark:text-slate-400">{kind.description}</p>}
        </div>
      </div>
      <SegmentedChoice
        className="pl-7"
        label={`Who hears about ${kind.label}`}
        value={mode}
        onChange={choose}
        disabled={save.isPending}
        options={MODES.map((m) => ({ value: m.mode, label: m.mode === "owners" ? `${m.label} (${owners})` : m.label }))}
      />
      {mode === "custom" && (
        <div className="pl-7 flex flex-wrap gap-1.5">
          {members.map((m) => {
            const on = picked.has(m.user_id);
            return (
              <button
                key={m.user_id}
                type="button"
                onClick={() => toggle(m.user_id)}
                disabled={save.isPending}
                aria-pressed={on}
                className={
                  "rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50 " +
                  (on
                    ? "border-accent bg-accent/10 text-content dark:text-mortar-100"
                    : "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800")
                }
                title={m.email}
              >
                {on ? "✓ " : ""}
                {m.display_name || m.email}
                <span className="ml-1 text-[10px] text-faint">{m.role}</span>
              </button>
            );
          })}
          {picked.size === 0 && <span className="text-[11px] text-faint self-center">Pick at least one person.</span>}
        </div>
      )}
    </div>
  );
}
