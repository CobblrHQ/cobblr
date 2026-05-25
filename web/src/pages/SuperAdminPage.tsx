// /super-admin — platform-operator dashboards. Gated by
// SUPERADMIN_EMAILS (server) + user.is_platform_admin (client).
//
// One page, six tabs:
//   1. Overview        — at-a-glance counts.
//   2. Workspaces      — every tenant + owner + activity recency.
//   3. Users           — cross-workspace user list with memberships.
//   4. Modules         — which workspaces have which modules enabled.
//   5. Activity        — global activity feed (filterable).
//   6. Health          — db + recent activity + backup status note.
//
// See docs/PRODUCTION_DEPLOY.md for the operator's launch flow.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  HeartPulse,
  LayoutGrid,
  Server,
  Users,
} from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

type Tab = "overview" | "workspaces" | "users" | "modules" | "activity" | "health";

const TABS: Array<{ id: Tab; label: string; icon: typeof Server }> = [
  { id: "overview", label: "Overview", icon: Server },
  { id: "workspaces", label: "Workspaces", icon: LayoutGrid },
  { id: "users", label: "Users", icon: Users },
  { id: "modules", label: "Modules", icon: Boxes },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "health", label: "Health", icon: HeartPulse },
];

export function SuperAdminPage() {
  usePageTitle("super-admin");
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  if (!user?.is_platform_admin) {
    return (
      <div className="rounded-xl border border-ember-200 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/20 p-5 text-sm text-ember-700 dark:text-ember-300">
        Platform-admin only. Set <code className="font-mono text-xs">SUPERADMIN_EMAILS</code> to include
        your email + restart the api to unlock this page.
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          super-admin
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          cross-workspace dashboards for the platform operator. workspace
          owners + admins can't reach this — separate tier.
        </span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-700">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition border-b-2 " +
                (active
                  ? "border-cobble-500 text-cobble-700 dark:text-cobble-300"
                  : "border-transparent text-slate-500 hover:text-cobble-600")
              }
            >
              <Icon size={12} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "workspaces" && <WorkspacesTab />}
      {tab === "users" && <UsersTab />}
      {tab === "modules" && <ModulesTab />}
      {tab === "activity" && <ActivityTab />}
      {tab === "health" && <HealthTab />}
    </div>
  );
}

function OverviewTab() {
  const q = useQuery({
    queryKey: ["super-admin-overview"],
    queryFn: () => api.superAdminOverview(),
    refetchInterval: 30_000,
  });
  if (q.isLoading) return <div className="text-xs text-slate-400">Loading…</div>;
  if (!q.data) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      <Stat label="Workspaces" value={q.data.orgs_count} />
      <Stat label="Users" value={q.data.users_count} />
      <Stat label="Active users (7d)" value={q.data.active_users_7d} />
      <Stat label="Activity (24h)" value={q.data.activity_24h} />
      <Stat label="Capability grants" value={q.data.capability_grants} />
      <Stat label="Bundles installed" value={q.data.bundles_installed} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
        {label}
      </div>
      <div className="font-display text-3xl font-bold text-slate-700 dark:text-mortar-100 mt-1">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function WorkspacesTab() {
  const q = useQuery({
    queryKey: ["super-admin-workspaces"],
    queryFn: () => api.superAdminWorkspaces(),
  });
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-mortar-50/50 dark:bg-slate-800/40">
          <tr>
            <Th>Workspace</Th>
            <Th>Owner</Th>
            <Th right>Members</Th>
            <Th>Last activity</Th>
            <Th>Plan</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {(q.data?.items ?? []).map((w) => (
            <tr key={w.id}>
              <td className="px-3 py-2">
                <div className="text-sm text-slate-700 dark:text-mortar-100">{w.name}</div>
                <div className="text-[10px] font-mono text-slate-400">{w.slug}</div>
              </td>
              <td className="px-3 py-2 text-xs">
                {w.owner ? (
                  <>
                    <div className="text-slate-700 dark:text-mortar-100">{w.owner.display_name}</div>
                    <div className="text-[10px] font-mono text-slate-400">{w.owner.email}</div>
                  </>
                ) : (
                  <span className="text-slate-400 italic">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{w.member_count}</td>
              <td className="px-3 py-2 text-xs text-slate-500">
                {w.last_activity_at ? new Date(w.last_activity_at).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-cobble-600">
                {w.plan}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsersTab() {
  const q = useQuery({
    queryKey: ["super-admin-users"],
    queryFn: () => api.superAdminUsers(),
  });
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-mortar-50/50 dark:bg-slate-800/40">
          <tr>
            <Th>User</Th>
            <Th>Workspaces</Th>
            <Th>Last login</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {(q.data?.items ?? []).map((u) => (
            <tr key={u.id}>
              <td className="px-3 py-2">
                <div className="text-sm text-slate-700 dark:text-mortar-100">{u.display_name}</div>
                <div className="text-[10px] font-mono text-slate-400">{u.email}</div>
              </td>
              <td className="px-3 py-2 text-xs">
                {u.orgs.length === 0 && (
                  <span className="text-slate-400 italic">none</span>
                )}
                <div className="flex flex-wrap gap-1">
                  {u.orgs.map((o) => (
                    <Link
                      key={o.org_id}
                      to={`/orgs/${o.org_slug}`}
                      className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono hover:bg-mortar-50 dark:hover:bg-slate-800"
                    >
                      {o.org_name} <span className="text-cobble-500">{o.role}</span>
                    </Link>
                  ))}
                </div>
              </td>
              <td className="px-3 py-2 text-xs text-slate-500">
                {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest">
                {!u.active && <span className="text-ember-500">inactive</span>}
                {u.active && u.must_reset_password && (
                  <span className="text-amber-500">pending-reset</span>
                )}
                {u.active && !u.must_reset_password && (
                  <span className="text-moss-500">active</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModulesTab() {
  const q = useQuery({
    queryKey: ["super-admin-modules"],
    queryFn: () => api.superAdminModules(),
  });
  return (
    <div className="space-y-3">
      {(q.data?.items ?? []).map((m) => (
        <div
          key={m.module_name}
          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
        >
          <div className="flex items-center justify-between">
            <div className="font-mono text-sm text-cobble-700 dark:text-cobble-300">
              {m.module_name}
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
              {m.workspace_count} workspace{m.workspace_count === 1 ? "" : "s"}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.workspaces.map((w) => (
              <span
                key={w.org_id}
                className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono"
                title={`Last migration: ${w.last_migration ?? "(none)"}`}
              >
                {w.org_name} <span className="text-cobble-500">v{w.version}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityTab() {
  const q = useQuery({
    queryKey: ["super-admin-activity"],
    queryFn: () => api.superAdminActivity({ limit: 100 }),
    refetchInterval: 15_000,
  });
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-mortar-50/50 dark:bg-slate-800/40">
          <tr>
            <Th>When</Th>
            <Th>Workspace</Th>
            <Th>User</Th>
            <Th>Action</Th>
            <Th>Entity</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {(q.data?.items ?? []).map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-1.5 text-[11px] text-slate-500 whitespace-nowrap">
                {new Date(a.occurred_at).toLocaleString()}
              </td>
              <td className="px-3 py-1.5 text-xs">{a.org_name ?? "—"}</td>
              <td className="px-3 py-1.5 text-xs">{a.user_display_name ?? a.user_email ?? "system"}</td>
              <td className="px-3 py-1.5 text-[11px] font-mono text-cobble-600">{a.action}</td>
              <td className="px-3 py-1.5 text-[11px] font-mono text-slate-400">
                {a.entity_type && a.entity_id ? `${a.entity_type}/${a.entity_id.slice(0, 8)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HealthTab() {
  const q = useQuery({
    queryKey: ["super-admin-health"],
    queryFn: () => api.superAdminHealth(),
    refetchInterval: 10_000,
  });
  if (q.isLoading) return <div className="text-xs text-slate-400">Loading…</div>;
  if (!q.data) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <HealthCard
        label="Database"
        ok={q.data.db.ok}
        detail={`Round-trip ${q.data.db.latency_ms} ms`}
      />
      <HealthCard
        label="Activity (last hour)"
        ok={true}
        detail={`${q.data.activity_1h} events`}
      />
      <HealthCard
        label="Backup"
        ok={q.data.backup.ok}
        detail={q.data.backup.note}
      />
      <HealthCard
        label="Timestamp"
        ok={true}
        detail={new Date(q.data.timestamp).toLocaleString()}
      />
    </div>
  );
}

function HealthCard({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail: string;
}) {
  const color = ok === true ? "moss" : ok === false ? "ember" : "slate";
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
          {label}
        </div>
        <span className={`text-xs font-mono text-${color}-600`}>
          {ok === true ? "OK" : ok === false ? "FAIL" : "—"}
        </span>
      </div>
      <div className="text-xs text-slate-600 dark:text-mortar-200 mt-1">{detail}</div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={
        "text-[10px] font-mono uppercase tracking-widest text-slate-400 px-3 py-2 " +
        (right ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}
