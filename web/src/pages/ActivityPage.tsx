// /activity — full audit feed for the active workspace, with
// filters by auth method (session / api_token / system), by entity
// type, and by token. Pollable every 10s.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter, KeyRound, ShieldCheck, Wrench, User } from "lucide-react";
import { api, type ActivityEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle } from "@cobblr/platform-web";

type AuthMethod = "session" | "api_token" | "system";

export function ActivityPage() {
  usePageTitle("Activity");
  const { activeSlug } = useActiveOrg();
  const [authFilter, setAuthFilter] = useState<AuthMethod | "all">("all");
  const [entityFilter, setEntityFilter] = useState<string>("");

  const activity = useQuery({
    queryKey: ["activity", activeSlug, authFilter, entityFilter],
    queryFn: () =>
      api.listActivity(activeSlug, {
        limit: 100,
        authMethods: authFilter === "all" ? undefined : [authFilter],
        entityType: entityFilter || undefined,
      }),
    enabled: !!activeSlug,
    refetchInterval: 10_000,
  });

  const items = activity.data?.items ?? [];

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          activity
        </h1>
        <span className="page-subtitle">
          everything that's happened in this workspace
        </span>
      </div>

      <div className="flex items-center gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <Filter size={11} className="text-faint" />
          <span className="font-mono uppercase tracking-widest text-[10px] text-muted">auth</span>
          {(["all", "session", "api_token", "system"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setAuthFilter(f)}
              className={
                "px-1.5 py-0.5 rounded font-mono text-[10px] transition " +
                (authFilter === f
                  ? "bg-cobble-100 text-accent dark:bg-cobble-700 dark:text-mortar-100"
                  : "text-faint hover:text-accent")
              }
            >
              {f === "api_token" ? "api" : f}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="font-mono uppercase tracking-widest text-[10px] text-muted">entity</span>
          <input
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            placeholder="part / wire / bundle / …"
            className="input !w-44 !py-1 !text-xs"
          />
        </label>
      </div>

      {activity.isLoading && (
        <div className="text-xs text-faint">loading…</div>
      )}
      {!activity.isLoading && items.length === 0 && (
        <div className="text-xs text-faint italic">No activity matches these filters.</div>
      )}

      <ul className="space-y-1.5">
        {items.map((it) => (
          <ActivityRow key={it.id} entry={it} />
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const tone = entry.action.includes("failed")
    ? "border-ember-200 bg-ember-50/40 dark:bg-slate-900 dark:border-ember-700/40"
    : entry.auth_method === "system"
    ? "border-line bg-subtle/40 dark:bg-slate-900 dark:border-slate-700"
    : "border-line bg-surface dark:bg-slate-900 dark:border-slate-700";
  return (
    <li className={"rounded-md border p-2.5 text-xs " + tone}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <AuthBadge method={entry.auth_method} />
        <span className="font-mono text-accent dark:text-cobble-300 font-semibold">
          {entry.action}
        </span>
        <span className="font-mono text-[10px] text-faint">
          {entry.entity_type}
          {entry.entity_id ? `:${entry.entity_id.slice(0, 8)}` : ""}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-faint">
          {new Date(entry.occurred_at).toLocaleString()}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-1 text-[10px] text-muted dark:text-slate-400">
        {entry.actor && (
          <span className="flex items-center gap-1">
            <User size={9} /> {entry.actor.display_name ?? entry.actor.email ?? "?"}
          </span>
        )}
        {entry.token && (
          <span className="flex items-center gap-1 font-mono">
            <KeyRound size={9} /> {entry.token.name}
            {entry.token.prefix && ` (${entry.token.prefix}…)`}
          </span>
        )}
        {entry.module_name && (
          <span className="font-mono">· module: {entry.module_name}</span>
        )}
      </div>
      {entry.diff != null && (
        <details className="mt-1.5">
          <summary className="text-[10px] font-mono text-faint cursor-pointer hover:text-accent">
            diff
          </summary>
          <pre className="mt-1 p-2 rounded bg-subtle/60 dark:bg-slate-800/60 font-mono text-[10px] overflow-x-auto text-content dark:text-mortar-200">
            {JSON.stringify(entry.diff, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

function AuthBadge({ method }: { method: AuthMethod }) {
  const cfg =
    method === "api_token"
      ? { label: "api", icon: KeyRound, cls: "bg-cobble-100 text-accent dark:bg-cobble-700/40 dark:text-cobble-200" }
      : method === "system"
      ? { label: "sys", icon: Wrench, cls: "bg-subtle text-content dark:bg-slate-700 dark:text-slate-300" }
      : { label: "ui", icon: ShieldCheck, cls: "bg-moss-100 text-moss-700 dark:bg-moss-700/40 dark:text-moss-200" };
  const Icon = cfg.icon;
  return (
    <span
      className={
        "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-mono uppercase tracking-widest text-[9px] " +
        cfg.cls
      }
    >
      <Icon size={9} />
      {cfg.label}
    </span>
  );
}
