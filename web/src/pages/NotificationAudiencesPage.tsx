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
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError, type NotificationAudienceKind, type NotificationAudienceMode, type WorkspaceMember } from "../lib/api";

const MODES: Array<{ mode: NotificationAudienceMode; label: string; blurb: string }> = [
  { mode: "all", label: "Everyone", blurb: "Every member of this workspace." },
  { mode: "owners", label: "Owners only", blurb: "Just the workspace's owners." },
  { mode: "custom", label: "Specific people", blurb: "Pick who." },
];

export function NotificationAudiencesPage() {
  usePageTitle("Who gets told");
  const { activeSlug, activeOrg } = useActiveOrg();
  const canEdit = activeOrg?.role === "owner" || activeOrg?.role === "admin";
  const kinds = useQuery({
    queryKey: ["notification-audiences", activeSlug],
    queryFn: () => api.listNotificationAudiences(activeSlug),
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
    <div className="space-y-5">
      <p className="text-sm text-faint dark:text-slate-400">
        Each kind of notification this workspace sends, and who it goes to. Everyone is the default. How
        each person is told (the bell, a Discord DM, email) is their own choice under Your account.
      </p>
      {kinds.isLoading && <div className="text-sm text-faint animate-pulse">Loading…</div>}
      {kinds.data && kinds.data.items.length === 0 && (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm text-faint">
          Nothing to route yet. Kinds appear here as modules that send notifications are enabled, and as the
          first of each kind arrives.
        </div>
      )}
      {[...byModule.entries()].map(([module, items]) => (
        <section key={module} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-4">
          <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">{module}</h2>
          {items.map((k) => (
            <KindRow key={k.event_type} slug={activeSlug} kind={k} members={members.data?.items ?? []} />
          ))}
        </section>
      ))}
    </div>
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
      <div className="flex flex-wrap gap-1.5 pl-7">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            onClick={() => choose(m.mode)}
            disabled={save.isPending}
            title={m.mode === "owners" ? `${owners} owner${owners === 1 ? "" : "s"}` : m.blurb}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-50 " +
              (mode === m.mode
                ? "border-cobble-600 bg-cobble-600 text-white"
                : "border-line dark:border-slate-600 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800")
            }
          >
            {m.label}
          </button>
        ))}
      </div>
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
