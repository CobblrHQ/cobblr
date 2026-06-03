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
// See docs/operations/PRODUCTION_DEPLOY.md for the operator's launch flow.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  CheckCircle,
  Download,
  HeartPulse,
  LayoutGrid,
  ShieldCheck,
  Server,
  ShoppingBag,
  Users,
  UserPlus,
  Copy,
  Trash2,
} from "lucide-react";
import { useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { ApiError, api, type SignupInvite } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

type Tab =
  | "overview"
  | "workspaces"
  | "users"
  | "invites"
  | "modules"
  | "marketplace"
  | "activity"
  | "health";

const TABS: Array<{ id: Tab; label: string; icon: typeof Server }> = [
  { id: "overview", label: "Overview", icon: Server },
  { id: "workspaces", label: "Workspaces", icon: LayoutGrid },
  { id: "users", label: "Users", icon: Users },
  { id: "invites", label: "Invites", icon: UserPlus },
  { id: "modules", label: "Modules", icon: Boxes },
  { id: "marketplace", label: "Marketplace", icon: ShoppingBag },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "health", label: "Health", icon: HeartPulse },
];

export function SuperAdminPage() {
  usePageTitle("Super-admin");
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  // Wait for /me hydration before judging access — otherwise a direct
  // load / fresh login flashes the "denied" box until auth resolves.
  if (loading) {
    return <div className="text-xs text-faint">Loading…</div>;
  }
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
      <div className="border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100">
          Super-admin
        </h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          Cross-workspace dashboards for the platform operator. Workspace
          owners + admins can't reach this — separate tier.
        </span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-line dark:border-slate-700">
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
                  ? "border-cobble-500 text-accent dark:text-cobble-300"
                  : "border-transparent text-muted hover:text-accent")
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
      {tab === "invites" && <InvitesTab />}
      {tab === "modules" && <ModulesTab />}
      {tab === "marketplace" && <MarketplaceTab />}
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
  if (q.isLoading) return <div className="text-xs text-faint">Loading…</div>;
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
        {label}
      </div>
      <div className="font-display text-3xl font-bold text-content dark:text-mortar-100 mt-1">
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-subtle/50 dark:bg-slate-800/40">
          <tr>
            <Th>Workspace</Th>
            <Th>Owner</Th>
            <Th right>Members</Th>
            <Th>Last activity</Th>
            <Th>Plan</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {(q.data?.items ?? []).map((w) => (
            <tr key={w.id}>
              <td className="px-3 py-2">
                <div className="text-sm text-content dark:text-mortar-100">{w.name}</div>
                <div className="text-[10px] font-mono text-faint">{w.slug}</div>
              </td>
              <td className="px-3 py-2 text-xs">
                {w.owner ? (
                  <>
                    <div className="text-content dark:text-mortar-100">{w.owner.display_name}</div>
                    <div className="text-[10px] font-mono text-faint">{w.owner.email}</div>
                  </>
                ) : (
                  <span className="text-faint italic">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{w.member_count}</td>
              <td className="px-3 py-2 text-xs text-muted">
                {w.last_activity_at ? new Date(w.last_activity_at).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-accent">
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-subtle/50 dark:bg-slate-800/40">
          <tr>
            <Th>User</Th>
            <Th>Workspaces</Th>
            <Th>Last login</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {(q.data?.items ?? []).map((u) => (
            <tr key={u.id}>
              <td className="px-3 py-2">
                <div className="text-sm text-content dark:text-mortar-100">{u.display_name}</div>
                <div className="text-[10px] font-mono text-faint">{u.email}</div>
              </td>
              <td className="px-3 py-2 text-xs">
                {u.orgs.length === 0 && (
                  <span className="text-faint italic">none</span>
                )}
                <div className="flex flex-wrap gap-1">
                  {u.orgs.map((o) => (
                    <Link
                      key={o.org_id}
                      to={`/orgs/${o.org_slug}`}
                      className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono hover:bg-subtle dark:hover:bg-slate-800"
                    >
                      {o.org_name} <span className="text-accent">{o.role}</span>
                    </Link>
                  ))}
                </div>
              </td>
              <td className="px-3 py-2 text-xs text-muted">
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
          className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4"
        >
          <div className="flex items-center justify-between">
            <div className="font-mono text-sm text-accent dark:text-cobble-300">
              {m.module_name}
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
              {m.workspace_count} workspace{m.workspace_count === 1 ? "" : "s"}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.workspaces.map((w) => (
              <span
                key={w.org_id}
                className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono"
                title={`Last migration: ${w.last_migration ?? "(none)"}`}
              >
                {w.org_name} <span className="text-accent">v{w.version}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Entity cell for the activity feed. UUIDs are noise at full length, so
// short-prefix them; readable ids (module names, slugs) show in full so
// the column isn't cut off mid-word ("core-vie" → "core-views").
function entityLabel(type: string | null, id: string | null): string {
  if (!type || !id) return "—";
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(id);
  return `${type}/${isUuid ? id.slice(0, 8) : id}`;
}

function ActivityTab() {
  const q = useQuery({
    queryKey: ["super-admin-activity"],
    queryFn: () => api.superAdminActivity({ limit: 100 }),
    refetchInterval: 15_000,
  });
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-subtle/50 dark:bg-slate-800/40">
          <tr>
            <Th>When</Th>
            <Th>Workspace</Th>
            <Th>User</Th>
            <Th>Action</Th>
            <Th>Entity</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {(q.data?.items ?? []).map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-1.5 text-[11px] text-muted whitespace-nowrap">
                {new Date(a.occurred_at).toLocaleString()}
              </td>
              <td className="px-3 py-1.5 text-xs">{a.org_name ?? "—"}</td>
              <td className="px-3 py-1.5 text-xs">{a.user_display_name ?? a.user_email ?? "system"}</td>
              <td className="px-3 py-1.5 text-[11px] font-mono text-accent">{a.action}</td>
              <td className="px-3 py-1.5 text-[11px] font-mono text-faint whitespace-nowrap">
                {entityLabel(a.entity_type, a.entity_id)}
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
  const cpu = useQuery({
    queryKey: ["super-admin-sandbox-cpu"],
    queryFn: () => api.superAdminSandboxCpu(),
    refetchInterval: 5_000,
  });
  const tel = useQuery({
    queryKey: ["super-admin-sandbox-telemetry"],
    queryFn: () => api.superAdminSandboxTelemetry(),
    refetchInterval: 10_000,
  });
  if (q.isLoading) return <div className="text-xs text-faint">Loading…</div>;
  if (!q.data) return null;
  return (
    <div className="space-y-5">
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
        <HealthCard label="Backup" ok={q.data.backup.ok} detail={q.data.backup.note} />
        <HealthCard
          label="Timestamp"
          ok={true}
          detail={new Date(q.data.timestamp).toLocaleString()}
        />
      </div>

      <div>
        <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-2">
          Sandbox CPU usage
        </h2>
        {cpu.data && cpu.data.workspaces.length === 0 && (
          <div className="text-xs text-faint italic">
            No sandboxed-module activity in the current window
            ({Math.round(cpu.data.window_ms / 1000)}s).
          </div>
        )}
        {cpu.data && cpu.data.workspaces.length > 0 && (
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
            <div className="px-4 py-2 bg-subtle/50 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-faint flex items-center gap-3">
              <span>
                quota {Math.round(cpu.data.quota_ms_per_window / 1000)}s /{" "}
                {Math.round(cpu.data.window_ms / 1000)}s window
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-subtle/30 dark:bg-slate-800/20">
                <tr>
                  <Th>Workspace</Th>
                  <Th right>Used ms</Th>
                  <Th right>Pct quota</Th>
                  <Th>By module</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-slate-800">
                {cpu.data.workspaces.map((w) => {
                  const pct = Math.round(w.pct * 100);
                  return (
                    <tr key={w.org_id}>
                      <td className="px-3 py-1.5 text-xs">
                        <div className="text-content dark:text-mortar-100">{w.name}</div>
                        <div className="text-[10px] font-mono text-faint">{w.slug}</div>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">
                        {w.used_ms.toLocaleString()}
                      </td>
                      <td
                        className={
                          "px-3 py-1.5 text-right font-mono text-xs " +
                          (pct >= 100
                            ? "text-ember-700 dark:text-ember-300 font-bold"
                            : pct >= 75
                              ? "text-orange-600 dark:text-orange-400"
                              : "text-muted")
                        }
                      >
                        {pct}%
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted font-mono">
                        {Object.entries(w.by_module)
                          .map(([m, ms]) => `${m}:${ms}ms`)
                          .join(" · ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-2">
          Sandbox invocation telemetry
        </h2>
        {tel.data && tel.data.rows.length === 0 && (
          <div className="text-xs text-faint italic">
            No sandboxed-module invocations recorded yet.
          </div>
        )}
        {tel.data && tel.data.rows.length > 0 && (
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-subtle/30 dark:bg-slate-800/20">
                <tr>
                  <Th>Workspace</Th>
                  <Th>Module</Th>
                  <Th right>Calls</Th>
                  <Th right>Errors</Th>
                  <Th right>p50</Th>
                  <Th right>p95</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-slate-800">
                {tel.data.rows.map((r) => {
                  const errPct = Math.round(r.error_rate * 100);
                  return (
                    <tr key={`${r.org_id}::${r.module_name}`}>
                      <td className="px-3 py-1.5 text-xs">
                        <div className="text-content dark:text-mortar-100">{r.name}</div>
                        <div className="text-[10px] font-mono text-faint">{r.slug}</div>
                      </td>
                      <td className="px-3 py-1.5 text-xs font-mono text-content dark:text-mortar-200">
                        {r.module_name}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">
                        {r.invocations.toLocaleString()}
                      </td>
                      <td
                        className={
                          "px-3 py-1.5 text-right font-mono text-xs " +
                          (errPct >= 10
                            ? "text-ember-600"
                            : errPct >= 1
                              ? "text-orange-600"
                              : "text-muted")
                        }
                      >
                        {r.errors}
                        {r.errors > 0 ? ` (${errPct}%)` : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">
                        {r.p50_ms}ms
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-xs">
                        {r.p95_ms}ms
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MarketplaceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [selectedVersion, setSelectedVersion] = useState<Record<string, string>>({});
  const q = useQuery({
    queryKey: ["sandbox-registry"],
    queryFn: () => api.sandboxRegistry(),
  });
  const install = useMutation({
    mutationFn: (args: { name: string; version: string }) => api.sandboxInstall(args),
    onSuccess: (data) => {
      toast.success(`Installed ${data.name}@${data.version}`);
      void qc.invalidateQueries({ queryKey: ["sandbox-registry"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "install failed"),
  });
  const uninstall = useMutation({
    mutationFn: (name: string) => api.sandboxUninstall(name),
    onSuccess: (data) => {
      toast.success(`Uninstalled ${data.name}`);
      void qc.invalidateQueries({ queryKey: ["sandbox-registry"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "uninstall failed"),
  });

  if (q.isLoading) return <div className="text-xs text-faint">Loading registry…</div>;
  if (q.isError || !q.data) {
    return (
      <div className="rounded-xl border border-ember-200 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/20 p-5 text-sm text-ember-700 dark:text-ember-300">
        Couldn't reach the registry. Set <code className="font-mono text-xs">COBBLR_REGISTRY_URL</code>{" "}
        + <code className="font-mono text-xs">COBBLR_REGISTRY_TOKEN</code> on the api container if your
        registry is private.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted dark:text-slate-400 px-1">
        Browse signed marketplace modules from the cobblr registry. Installing
        downloads, verifies sha256 + ed25519 signature, extracts to
        <code className="font-mono text-[11px] mx-1">/var/cobblr/sandboxed-modules/</code>,
        and registers without restarting the api.
      </div>
      {q.data.items.length === 0 && (
        <div className="text-xs text-faint italic px-1">No modules listed.</div>
      )}
      {q.data.items.map((m) => {
        const latest = m.versions[0];
        const installed = m.installed;
        const installedThisVersion =
          installed && latest && installed.version === latest.version;
        const pickedVersion = selectedVersion[m.name] ?? latest?.version ?? "";
        const targetVersionSpec =
          m.versions.find((v) => v.version === pickedVersion) ?? latest;
        return (
          <div
            key={m.name}
            className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-display font-bold text-content dark:text-mortar-100">
                    {m.display_name ?? m.name}
                  </div>
                  <span className="text-[10px] font-mono text-faint">{m.name}</span>
                  {m.public_key_ed25519 && (
                    <span
                      title="ed25519 signed"
                      className="inline-flex items-center gap-1 text-[10px] font-mono text-moss-600"
                    >
                      <ShieldCheck size={11} /> signed
                    </span>
                  )}
                </div>
                {m.description && (
                  <div className="text-xs text-muted dark:text-slate-400 mt-1">
                    {m.description}
                  </div>
                )}
                {m.author && (
                  <div className="text-[10px] font-mono text-faint mt-1">
                    {m.author}
                    {m.homepage && (
                      <>
                        {" · "}
                        <a
                          href={m.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          homepage
                        </a>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="shrink-0 flex flex-col items-end gap-1">
                {m.versions.length > 1 && (
                  <select
                    value={pickedVersion}
                    onChange={(e) =>
                      setSelectedVersion((s) => ({ ...s, [m.name]: e.target.value }))
                    }
                    className="text-[11px] font-mono rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1"
                  >
                    {m.versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        v{v.version}
                        {!v.signature ? " (unsigned)" : ""}
                      </option>
                    ))}
                  </select>
                )}
                {installed ? (
                  installedThisVersion && pickedVersion === installed.version ? (
                    <span className="inline-flex items-center gap-1 text-xs text-moss-700 dark:text-moss-300">
                      <CheckCircle size={12} /> installed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        targetVersionSpec &&
                        install.mutate({ name: m.name, version: targetVersionSpec.version })
                      }
                      disabled={install.isPending || !targetVersionSpec}
                      className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                    >
                      <Download size={11} />{" "}
                      {pickedVersion === installed.version
                        ? "Reinstall"
                        : `Switch to ${pickedVersion}`}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      targetVersionSpec &&
                      install.mutate({ name: m.name, version: targetVersionSpec.version })
                    }
                    disabled={install.isPending || !targetVersionSpec}
                    className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                  >
                    <Download size={11} /> Install {pickedVersion}
                  </button>
                )}
                {installed && (
                  <div className="text-[10px] font-mono text-faint">
                    v{installed.version} · {installed.source}
                  </div>
                )}
                {installed && installed.source === "registry" && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Uninstall ${m.name}?`,
                        message:
                          "Removes the wasm + registry record. Workspace org_modules rows that enabled it stay until you tidy them up.",
                        confirmLabel: "Uninstall",
                        destructive: true,
                      });
                      if (ok) uninstall.mutate(m.name);
                    }}
                    disabled={uninstall.isPending}
                    className="text-[10px] font-mono text-ember-600 hover:text-ember-700 hover:underline disabled:opacity-50"
                  >
                    Uninstall
                  </button>
                )}
                {installed && installed.source === "image" && (
                  <div
                    className="text-[10px] font-mono text-faint"
                    title="Image-baked modules can't be uninstalled at runtime — they ship with the cobblr-core image."
                  >
                    image-baked
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
          {label}
        </div>
        <span className={`text-xs font-mono text-${color}-600`}>
          {ok === true ? "OK" : ok === false ? "FAIL" : "—"}
        </span>
      </div>
      <div className="text-xs text-content dark:text-mortar-200 mt-1">{detail}</div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={
        "text-[10px] font-mono uppercase tracking-widest text-faint px-3 py-2 " +
        (right ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}

// ── Invites: single-use signup links (invite-only beta) ─────────────────
function InvitesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const invites = useQuery({ queryKey: ["signup-invites"], queryFn: () => api.listSignupInvites() });
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState("14");
  const [freshLink, setFreshLink] = useState<string | null>(null);

  const mint = useMutation({
    mutationFn: () => api.mintSignupInvite({
      email: email.trim() || undefined,
      note: note.trim() || undefined,
      expires_in_days: days ? Number(days) : undefined,
    }),
    onSuccess: (inv) => {
      setFreshLink(`${window.location.origin}/join/${inv.token}`);
      setEmail(""); setNote("");
      void qc.invalidateQueries({ queryKey: ["signup-invites"] });
      toast.success("Invite minted — copy the link below.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't mint"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSignupInvite(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["signup-invites"] }); toast.success("Revoked."); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't revoke"),
  });

  return (
    <div className="space-y-5">
      <p className="text-sm text-content dark:text-mortar-200">
        Mint a <strong>single-use link</strong> so one new person can sign up and get their own
        workspace — even while public signup is off. The link is shown once; it's a credential, so
        give it directly to the person and set a short expiry.
      </p>

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// new invite</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Lock to email (optional)</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@example.com" className="input w-full" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="for a beta tester" className="input w-full" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Expires in (days)</span>
            <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="input w-full" />
          </label>
        </div>
        <button onClick={() => mint.mutate()} disabled={mint.isPending} className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 inline-flex items-center gap-1.5">
          <UserPlus size={14} /> Mint invite link
        </button>
        {freshLink && (
          <div className="rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 p-3 space-y-1.5">
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent">// copy this now — shown once</div>
            <div className="flex items-center gap-2">
              <input readOnly value={freshLink} onFocus={(e) => e.currentTarget.select()} className="input flex-1 font-mono text-xs" />
              <button onClick={() => { void navigator.clipboard?.writeText(freshLink); toast.success("Copied."); }} className="p-2 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Copy"><Copy size={14} /></button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 text-left">
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Status</th>
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">For</th>
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Redeemed by</th>
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Expires</th>
              <th className="px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {(invites.data?.items ?? []).map((inv: SignupInvite) => (
              <tr key={inv.id} className="border-b border-line dark:border-slate-800 last:border-0">
                <td className="px-3 py-1.5"><StatusPill status={inv.status} /></td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200">{inv.invited_email ?? <span className="text-faint">anyone</span>}{inv.note ? <span className="text-faint"> · {inv.note}</span> : null}</td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200">{inv.consumed_by_email ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted">{inv.expires_at ? new Date(inv.expires_at).toLocaleDateString() : "never"}</td>
                <td className="px-3 py-1.5 text-right">
                  {inv.status === "open" && (
                    <button onClick={async () => { if (await confirm({ title: "Revoke invite?", message: "The link stops working immediately.", destructive: true })) revoke.mutate(inv.id); }} className="text-faint hover:text-ember-500 transition" title="Revoke"><Trash2 size={13} /></button>
                  )}
                </td>
              </tr>
            ))}
            {(invites.data?.items.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-faint italic">No invites yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    consumed: "bg-cobble-100 text-accent dark:bg-cobble-900/40 dark:text-cobble-300",
    expired: "bg-mortar-100 text-muted dark:bg-slate-800 dark:text-slate-400",
    revoked: "bg-ember-100 text-ember-700 dark:bg-ember-900/40 dark:text-ember-300",
  };
  return <span className={"inline-block rounded px-1.5 py-0.5 text-[10px] font-mono uppercase " + (map[status] ?? map.expired)}>{status}</span>;
}
