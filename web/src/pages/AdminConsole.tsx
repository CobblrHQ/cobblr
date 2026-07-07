// The platform-operator console content — the routed sections of the SEPARATE
// operator interface at /admin/:section. The shell (components/AdminLayout.tsx)
// owns the operator chrome, the section nav, and the is_platform_admin gate;
// AdminConsole here just dispatches the active section to its tab component, and
// the rest of the file holds those section components (Overview, Workspaces,
// Users, Invites, Feedback, Announcements, Modules, Marketplace, Activity, AI,
// Scan Eval, Health). Section list: lib/adminSections.ts.
//
// Access is gated server-side by SUPERADMIN_EMAILS (every /super-admin/* API)
// and client-side by AdminLayout. See docs/operations/PRODUCTION_DEPLOY.md.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  Download,
  ShieldCheck,
  UserPlus,
  Copy,
  Trash2,
  X,
  Eye,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useConfirm, usePageTitle, useToast, Modal, useImageSrc } from "@cobblr/platform-web";
import { setImpersonation } from "../lib/impersonation";
import { displaySlug } from "../lib/workspaceSlug";
import {
  ApiError,
  api,
  type SignupInvite,
  type WaitlistEntry,
  type SuperAdminAiActivityItem,
  type SuperAdminBarcodeCacheItem,
  type FeedbackItem,
  type ScanEvalCase,
} from "../lib/api";
import { ADMIN_SECTIONS, isAdminSection, type AdminSectionId } from "../lib/adminSections";
import { TokenManager } from "../components/TokenManager";
import { ScanResolversTab } from "../components/ScanResolversTab";

// The console content — one routed section at a time. The shell (AdminLayout)
// owns the operator chrome + the section nav; this just dispatches /admin/:section
// to the matching tab component. Access is gated by AdminLayout (is_platform_admin),
// so no gate here.
export function AdminConsole() {
  const { section } = useParams<{ section: string }>();
  const active: AdminSectionId = isAdminSection(section) ? section : "overview";
  const label = ADMIN_SECTIONS.find((s) => s.id === active)?.label ?? "Overview";
  usePageTitle(`Operator · ${label}`);

  return (
    <div className="space-y-5">
      {active === "overview" && <OverviewTab />}
      {active === "workspaces" && <WorkspacesTab />}
      {active === "users" && <UsersTab />}
      {active === "invites" && <InvitesTab />}
      {active === "waitlist" && <WaitlistTab />}
      {active === "feedback" && <FeedbackTab />}
      {active === "announce" && <AnnouncementsTab />}
      {active === "modules" && <ModulesTab />}
      {active === "marketplace" && <MarketplaceTab />}
      {active === "activity" && <ActivityTab />}
      {active === "metrics" && <ProductMetricsTab />}
      {active === "ai" && <AiActivityTab />}
      {active === "barcodes" && <BarcodeCacheTab />}
      {active === "tokens" && <TokenManager variant="operator" />}
      {active === "scaneval" && <ScanEvalTab />}
      {active === "scan-resolvers" && <ScanResolversTab />}
      {active === "impersonation" && <ImpersonationLogTab />}
      {active === "health" && <HealthTab />}
    </div>
  );
}

function OverviewTab() {
  const q = useQuery({
    queryKey: ["super-admin-overview"],
    queryFn: () => api.superAdminOverview(),
    refetchInterval: 30_000,
  });
  // Separate queries: the AI roll-up loops tenant DBs and health pings the
  // db — neither belongs inside the meta-cheap /overview poll.
  const ai = useQuery({
    queryKey: ["super-admin-ai-summary"],
    queryFn: () => api.superAdminAiSummary(),
    staleTime: 120_000,
  });
  const health = useQuery({
    queryKey: ["super-admin-health-mini"],
    queryFn: () => api.superAdminHealth(),
    refetchInterval: 60_000,
  });
  if (q.isLoading) return <div className="text-xs text-faint">Loading…</div>;
  if (!q.data) return null;
  const d = q.data;
  const attention = d.feedback_open + d.waitlist_pending;
  return (
    <div className="space-y-6">
      {/* The reason an operator opens this page: does anything need me? */}
      <div>
        <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-2">
          Needs attention{attention === 0 ? " — all clear" : ""}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Stat label="Open feedback" value={d.feedback_open} to="/admin/feedback" alert={d.feedback_open > 0} />
          <Stat label="Waitlist pending" value={d.waitlist_pending} to="/admin/waitlist" alert={d.waitlist_pending > 0} />
          <Stat label="Activity (24h)" value={d.activity_24h} to="/admin/activity" />
          {health.data && (
            <StatText
              label="Health"
              value={health.data.db.ok ? "OK" : "DEGRADED"}
              to="/admin/health"
              alert={!health.data.db.ok}
            />
          )}
          {ai.data && (
            <StatText
              label="AI (24h)"
              value={`${ai.data.calls_24h} calls${ai.data.cost_cents_24h ? ` · $${(ai.data.cost_cents_24h / 100).toFixed(2)}` : ""}`}
              to="/admin/ai"
            />
          )}
        </div>
      </div>

      <div>
        <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-2">
          Platform
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Stat label="Workspaces" value={d.orgs_count} to="/admin/workspaces" />
          <Stat label="Users" value={d.users_count} to="/admin/users" />
          <Stat label="Active users (7d)" value={d.active_users_7d} to="/admin/users" />
          <Stat label="Barcode cache (UPCs)" value={d.barcode_cache_upcs} to="/admin/barcodes" />
          <Stat label="Capability grants" value={d.capability_grants} />
          <Stat label="Bundles installed" value={d.bundles_installed} />
        </div>
      </div>

      {d.build_sha && (
        <div className="text-[10px] font-mono text-faint dark:text-slate-500">
          build {d.build_sha.slice(0, 10)}
        </div>
      )}
    </div>
  );
}

function StatText({ label, value, to, alert }: { label: string; value: string; to?: string; alert?: boolean }) {
  const inner = (
    <>
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint">{label}</div>
      <div
        className={
          "font-display text-2xl font-bold mt-1.5 " +
          (alert ? "text-ember-600 dark:text-ember-400" : "text-content dark:text-mortar-100")
        }
      >
        {value}
      </div>
    </>
  );
  const cls =
    "rounded-xl border bg-surface dark:bg-slate-900 p-4 block " +
    (alert ? "border-ember-300 dark:border-ember-700" : "border-line dark:border-slate-700");
  return to ? (
    <Link to={to} className={cls + " hover:border-cobble-400 dark:hover:border-cobble-500 transition"}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function Stat({ label, value, to, alert }: { label: string; value: number; to?: string; alert?: boolean }) {
  const inner = (
    <>
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
        {label}
      </div>
      <div
        className={
          "font-display text-3xl font-bold mt-1 " +
          (alert ? "text-ember-600 dark:text-ember-400" : "text-content dark:text-mortar-100")
        }
      >
        {value.toLocaleString()}
      </div>
    </>
  );
  const cls =
    "rounded-xl border bg-surface dark:bg-slate-900 p-4 block " +
    (alert
      ? "border-ember-300 dark:border-ember-700"
      : "border-line dark:border-slate-700");
  // Every number should answer "where do I act on this?" — link when a
  // section exists for it.
  return to ? (
    <Link to={to} className={cls + " hover:border-cobble-400 dark:hover:border-cobble-500 transition"}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function WorkspacesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"activity" | "name" | "members">("activity");
  const q = useQuery({
    queryKey: ["super-admin-workspaces"],
    queryFn: () => api.superAdminWorkspaces(),
  });
  const setPlan = useMutation({
    mutationFn: (v: { id: string; plan: "free" | "paid" | "disabled" }) =>
      api.superAdminSetWorkspacePlan(v.id, v.plan),
    onSuccess: (r) => {
      toast.success(r.plan === "disabled" ? "Workspace disabled." : `Plan set to ${r.plan}.`);
      void qc.invalidateQueries({ queryKey: ["super-admin-workspaces"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't update."),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.superAdminDeleteWorkspace(id),
    onSuccess: () => {
      toast.success("Workspace deleted.");
      void qc.invalidateQueries({ queryKey: ["super-admin-workspaces"] });
      void qc.invalidateQueries({ queryKey: ["super-admin-overview"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });
  async function handleDelete(w: { id: string; name: string; slug: string; member_count: number }) {
    const ok = await confirm({
      title: `Delete "${w.name}"?`,
      message: `Hard-deletes workspace ${w.slug} (${w.member_count} member${w.member_count === 1 ? "" : "s"}): its tenant database is DROPPED and every entity in it is gone. This cannot be undone. Built for clearing e2e/test detritus — be sure.`,
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (ok) del.mutate(w.id);
  }
  const needle = search.trim().toLowerCase();
  const items = (q.data?.items ?? [])
    .filter(
      (w) =>
        !needle ||
        w.name.toLowerCase().includes(needle) ||
        w.slug.toLowerCase().includes(needle) ||
        (w.owner?.email ?? "").toLowerCase().includes(needle) ||
        (w.owner?.display_name ?? "").toLowerCase().includes(needle),
    )
    .sort((a, b) =>
      sortBy === "name"
        ? a.name.localeCompare(b.name)
        : sortBy === "members"
          ? b.member_count - a.member_count
          : new Date(b.last_activity_at ?? 0).getTime() - new Date(a.last_activity_at ?? 0).getTime(),
    );
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, slug, or owner…"
          className="input max-w-sm"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="input w-auto"
          title="Sort"
        >
          <option value="activity">recent activity</option>
          <option value="name">name</option>
          <option value="members">members</option>
        </select>
        <span className="text-xs text-faint font-mono">
          {items.length}/{q.data?.items.length ?? 0}
        </span>
      </div>
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-subtle/50 dark:bg-slate-800/40">
          <tr>
            <Th>Workspace</Th>
            <Th>Owner</Th>
            <Th right>Members</Th>
            <Th>Last activity</Th>
            <Th>Plan</Th>
            <Th right> </Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-800">
          {items.map((w) => (
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
              <td className="px-3 py-2">
                {/* The plan IS the disable switch — withTenant 403s every
                    tenant call for plan=disabled, so this select is honest. */}
                <select
                  value={w.plan}
                  onChange={(e) => setPlan.mutate({ id: w.id, plan: e.target.value as "free" | "paid" | "disabled" })}
                  disabled={setPlan.isPending}
                  className={
                    "rounded-md border bg-surface dark:bg-slate-900 px-1.5 py-1 text-[10px] font-mono uppercase tracking-widest " +
                    (w.plan === "disabled"
                      ? "border-ember-400 text-ember-600 dark:text-ember-400"
                      : "border-line dark:border-slate-700 text-accent")
                  }
                >
                  <option value="free">free</option>
                  <option value="paid">paid</option>
                  <option value="disabled">disabled</option>
                </select>
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => void handleDelete(w)}
                  disabled={del.isPending}
                  className="text-faint hover:text-ember-500 transition p-1"
                  title="Delete workspace (hard delete — drops its tenant DB)"
                >
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
          {!q.isLoading && items.length === 0 && (
            <tr><td colSpan={6} className="px-3 py-6 text-center text-faint text-xs">No workspaces match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
    </div>
  );
}

function UsersTab() {
  const [search, setSearch] = useState("");
  const [viewAs, setViewAs] = useState<{ userId: string; userName: string; orgId: string; orgName: string } | null>(null);
  const q = useQuery({
    queryKey: ["super-admin-users"],
    queryFn: () => api.superAdminUsers(),
  });
  const needle = search.trim().toLowerCase();
  const items = (q.data?.items ?? []).filter(
    (u) =>
      !needle ||
      u.display_name.toLowerCase().includes(needle) ||
      u.email.toLowerCase().includes(needle) ||
      u.orgs.some((o) => o.org_name.toLowerCase().includes(needle)),
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, or workspace…"
          className="input max-w-sm"
        />
        <span className="text-xs text-faint font-mono">
          {items.length}/{q.data?.items.length ?? 0}
        </span>
      </div>
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden overflow-x-auto">
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
          {items.map((u) => (
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
                    // "View as": start a read-only, audited impersonation session
                    // to see this user's workspace exactly as they see it.
                    <button
                      key={o.org_id}
                      onClick={() => setViewAs({ userId: u.id, userName: u.display_name, orgId: o.org_id, orgName: o.org_name })}
                      title={`View ${u.display_name}'s "${o.org_name}" workspace (read-only)`}
                      className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-content dark:text-mortar-100 hover:border-accent hover:bg-subtle/60 transition"
                    >
                      <Eye size={10} className="text-accent" /> {o.org_name} <span className="text-accent">{o.role}</span>
                    </button>
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
          {!q.isLoading && items.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-faint text-xs">No users match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
    {viewAs && <ViewAsModal target={viewAs} onClose={() => setViewAs(null)} />}
    </div>
  );
}

// "View as" — mint a read-only impersonation session, store it per-tab, and open
// the workspace. Required reason; short TTL. See operator-impersonation.md.
function ViewAsModal({
  target,
  onClose,
}: {
  target: { userId: string; userName: string; orgId: string; orgName: string };
  onClose: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [ttl, setTtl] = useState(30);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!reason.trim()) {
      toast.error("A reason is required (it's logged).");
      return;
    }
    setBusy(true);
    try {
      const s = await api.request<{
        session_id: string;
        token: string;
        expires_at: string;
        mode: "read" | "write";
        target: { id: string; name: string; role: string };
        workspace: { id: string; slug: string; name: string };
      }>("POST", "/super-admin/impersonations", {
        org_id: target.orgId,
        target_user_id: target.userId,
        reason: reason.trim(),
        ttl_min: ttl,
      });
      setImpersonation(s);
      // Open the workspace by its pretty handle; the banner + X-Impersonation
      // take over from there.
      window.location.assign(`/w/${displaySlug(s.workspace.slug)}/`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the session.");
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="View as — read-only support session" size="md">
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          You'll see <b>{target.orgName}</b> exactly as <b>{target.userName}</b> does. It starts
          <b> read-only</b> (you can enable editing from the banner). The session is time-boxed,
          logged, and leaves a visible note in the workspace's activity feed.
        </p>
        <label className="block">
          <span className="text-xs text-faint">Reason (logged, required)</span>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. investigating their 'low contrast button' report"
            className="input w-full mt-1"
          />
        </label>
        <label className="block">
          <span className="text-xs text-faint">Session length</span>
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="input w-full mt-1">
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-muted hover:bg-subtle/60">Cancel</button>
          <button
            onClick={start}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 disabled:opacity-50"
          >
            <Eye size={14} /> {busy ? "Starting…" : "Start read-only session"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// The append-only View-as log: who viewed whose workspace, why, for how long.
function ImpersonationLogTab() {
  const q = useQuery({
    queryKey: ["super-admin-impersonations"],
    queryFn: () =>
      api.request<{
        items: Array<{
          id: string;
          reason: string;
          mode: "read" | "write";
          request_count: number;
          created_at: string;
          expires_at: string;
          write_enabled_at: string | null;
          ended_at: string | null;
          operator_email: string | null;
          operator_name: string | null;
          target_email: string | null;
          target_name: string | null;
          workspace_slug: string | null;
          workspace_name: string | null;
        }>;
      }>("GET", "/super-admin/impersonations"),
    refetchInterval: 30_000,
  });
  const items = q.data?.items ?? [];
  const now = Date.now();
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Every operator "View as" session — append-only. Read-only by default; <b>write</b> means editing
        was deliberately enabled. Each session also leaves a trace in the workspace's own activity feed.
      </p>
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-subtle/50 dark:bg-slate-800/40">
            <tr>
              <Th>Operator</Th>
              <Th>Viewed</Th>
              <Th>Workspace</Th>
              <Th>Reason</Th>
              <Th>Mode</Th>
              <Th>Reqs</Th>
              <Th>When</Th>
              <Th>State</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-800">
            {items.map((s) => {
              const live = !s.ended_at && new Date(s.expires_at).getTime() > now;
              return (
                <tr key={s.id}>
                  <td className="px-3 py-2 text-xs">{s.operator_name ?? s.operator_email ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{s.target_name ?? s.target_email ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{s.workspace_name ?? s.workspace_slug ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted max-w-[240px] truncate" title={s.reason}>{s.reason}</td>
                  <td className="px-3 py-2 text-[10px] font-mono uppercase">
                    {s.write_enabled_at ? <span className="text-red-500">write</span> : <span className="text-amber-500">read</span>}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">{s.request_count}</td>
                  <td className="px-3 py-2 text-[11px] text-muted">{new Date(s.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-[10px] font-mono uppercase tracking-widest">
                    {live ? <span className="text-moss-500">live</span> : s.ended_at ? <span className="text-faint">ended</span> : <span className="text-faint">expired</span>}
                  </td>
                </tr>
              );
            })}
            {!q.isLoading && items.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-faint text-xs">No impersonation sessions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
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
  const cfg = useQuery({
    queryKey: ["super-admin-instance-config"],
    queryFn: () => api.superAdminInstanceConfig(),
    staleTime: 60_000,
  });
  const resolver = useQuery({
    queryKey: ["super-admin-resolver-stats"],
    queryFn: () => api.superAdminResolverStats(),
    refetchInterval: 30_000,
    retry: false,
    // Only ask once the config CONFIRMS a resolver exists — firing before
    // config loads produced a guaranteed 503 on every Health visit for
    // resolver-less instances (post-fix verification, 2026-06-11).
    enabled: cfg.data?.barcode_resolver_configured === true,
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

      {/* Which mode is this instance in — stops "what's the signup gate set
          to?" requiring a box ssh. Read-only booleans; secrets never leave
          the api. */}
      {cfg.data && (
        <div>
          <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-2">
            Instance configuration
          </h2>
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            {([
              ["Environment", cfg.data.node_env, null],
              ["Build", cfg.data.build_sha ? cfg.data.build_sha.slice(0, 10) : "unknown", null],
              ["Public signup", cfg.data.public_signup ? "open" : "closed", cfg.data.public_signup],
              ["Self-serve invites", cfg.data.self_serve_invites ? "on" : "off", cfg.data.self_serve_invites],
              ["AI (instance switch)", cfg.data.ai_enabled ? "enabled" : "KILLED", cfg.data.ai_enabled],
              ["Barcode resolver", cfg.data.barcode_resolver_configured ? "configured" : "not configured", cfg.data.barcode_resolver_configured],
            ] as Array<[string, string, boolean | null]>).map(([k, v, on]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 min-w-0">
                <span className="text-[10px] font-mono uppercase tracking-wider text-faint shrink-0">{k}</span>
                <span
                  className={
                    "font-mono text-xs truncate " +
                    (on === null
                      ? "text-content dark:text-mortar-100"
                      : on
                        ? "text-moss-600 dark:text-moss-400"
                        : "text-muted dark:text-slate-400")
                  }
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The box-level barcode resolver (shared cache + provider chain for
          every product on the host). */}
      {cfg.data?.barcode_resolver_configured && (
        <div>
          <h2 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-2">
            Barcode resolver
          </h2>
          {resolver.data ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <HealthCard label="Cached UPCs" ok={true} detail={String(resolver.data.cached_upcs)} />
              <HealthCard label="Hits" ok={true} detail={String(resolver.data.hits)} />
              <HealthCard
                label="upcitemdb today"
                ok={resolver.data.upcitemdb_today.used < resolver.data.upcitemdb_today.budget}
                detail={`${resolver.data.upcitemdb_today.used} / ${resolver.data.upcitemdb_today.budget}`}
              />
              <HealthCard
                label="upcitemdb state"
                ok={!resolver.data.upcitemdb_today.blocked_until || resolver.data.upcitemdb_today.blocked_until < Date.now()}
                detail={
                  resolver.data.upcitemdb_today.blocked_until && resolver.data.upcitemdb_today.blocked_until > Date.now()
                    ? `throttled until ${new Date(resolver.data.upcitemdb_today.blocked_until).toLocaleTimeString()}`
                    : "available"
                }
              />
            </div>
          ) : (
            <div className="text-xs text-faint italic">
              {resolver.isLoading ? "Asking the resolver…" : "Resolver unreachable from the api right now."}
            </div>
          )}
        </div>
      )}

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
                          href={m.homepage && /^https?:\/\//i.test(m.homepage) ? m.homepage : undefined}
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
  const [emailedTo, setEmailedTo] = useState<string | null>(null);

  const mint = useMutation({
    mutationFn: () => api.mintSignupInvite({
      email: email.trim() || undefined,
      note: note.trim() || undefined,
      expires_in_days: days ? Number(days) : undefined,
    }),
    onSuccess: (inv) => {
      setFreshLink(`${window.location.origin}/join/${inv.token}`);
      setEmailedTo(inv.emailed ? inv.invited_email : null);
      const sentTo = inv.emailed ? inv.invited_email : null;
      setEmail(""); setNote("");
      void qc.invalidateQueries({ queryKey: ["signup-invites"] });
      toast.success(sentTo ? `Invite emailed to ${sentTo}.` : "Invite minted — copy the link below.");
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
        workspace — even while public signup is off. Add an email and we'll{" "}
        <strong>send them the link directly</strong>; otherwise the link is shown once (it's a
        credential — hand it over yourself and set a short expiry).
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
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="for a teammate" className="input w-full" />
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
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
              {emailedTo ? `// emailed to ${emailedTo} — link also shown here` : "// copy this now — shown once"}
            </div>
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

function WaitlistTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ["waitlist"], queryFn: () => api.listWaitlist() });
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [emailedTo, setEmailedTo] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: (id: string) => api.approveWaitlist(id),
    onSuccess: (r) => {
      setFreshLink(`${window.location.origin}/join/${r.invite.token}`);
      setEmailedTo(r.invite.emailed ? r.invite.invited_email : null);
      void qc.invalidateQueries({ queryKey: ["waitlist"] });
      void qc.invalidateQueries({ queryKey: ["signup-invites"] });
      toast.success(r.invite.emailed ? `Invite emailed to ${r.invite.invited_email}.` : "Invite minted — copy the link below.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't approve"),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissWaitlist(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["waitlist"] }); toast.success("Dismissed."); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't dismiss"),
  });

  const pending = (list.data?.items ?? []).filter((w) => w.status === "pending").length;

  return (
    <div className="space-y-5">
      <p className="text-sm text-content dark:text-mortar-200">
        Signups from the <strong>marketing site's waitlist</strong> (cobblr.xyz), forwarded as they
        happen. <strong>Approve</strong> mints a single-use invite locked to that email — and emails
        them the join link when the managed sender is configured (14-day expiry by default).
        {pending > 0 && <span className="text-accent font-medium"> {pending} waiting.</span>}
      </p>

      {freshLink && (
        <div className="rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 p-3 space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
            {emailedTo ? `// emailed to ${emailedTo} — link also shown here` : "// copy this now — shown once"}
          </div>
          <div className="flex items-center gap-2">
            <input readOnly value={freshLink} onFocus={(e) => e.currentTarget.select()} className="input flex-1 font-mono text-xs" />
            <button onClick={() => { void navigator.clipboard?.writeText(freshLink); toast.success("Copied."); }} className="p-2 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Copy"><Copy size={14} /></button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 text-left">
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Status</th>
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Email</th>
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Signed up</th>
              <th className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider">Invite</th>
              <th className="px-3 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((w: WaitlistEntry) => (
              <tr key={w.id} className="border-b border-line dark:border-slate-800 last:border-0">
                <td className="px-3 py-1.5"><StatusPill status={w.status} /></td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200 font-medium">{w.email}<span className="text-faint font-normal"> · {w.source}</span></td>
                <td className="px-3 py-1.5 text-muted">{new Date(w.signed_up_at ?? w.created_at).toLocaleString()}</td>
                <td className="px-3 py-1.5 text-muted">{w.status === "invited" ? (w.invite_status ?? "—") : "—"}</td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  {w.status === "pending" && (
                    <>
                      <button onClick={() => approve.mutate(w.id)} disabled={approve.isPending} className="inline-flex items-center gap-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white px-2 py-1 text-[11px] font-medium transition disabled:opacity-50" title="Mint + email an invite">
                        <UserPlus size={12} /> Approve
                      </button>
                      <button onClick={async () => { if (await confirm({ title: "Dismiss signup?", message: `${w.email} won't be invited (they can sign up again later).`, destructive: true })) dismiss.mutate(w.id); }} className="ml-2 text-faint hover:text-ember-500 transition" title="Dismiss">
                        <X size={13} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {(list.data?.items.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-faint italic">No signups yet — they appear here the moment someone joins the waitlist on cobblr.xyz.</td></tr>
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
    pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    invited: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    dismissed: "bg-mortar-100 text-muted dark:bg-slate-800 dark:text-slate-400",
  };
  return <span className={"inline-block rounded px-1.5 py-0.5 text-[10px] font-mono uppercase " + (map[status] ?? map.expired)}>{status}</span>;
}

// ── AI tab — cross-workspace AI activity log ──
function AiActivityTab() {
  const [org, setOrg] = useState("");
  const [userQ, setUserQ] = useState("");
  const [capability, setCapability] = useState("");
  const [source, setSource] = useState("");
  const [filters, setFilters] = useState<{ org?: string; user?: string; capability?: string; source?: string }>({});
  const [detail, setDetail] = useState<SuperAdminAiActivityItem | null>(null);

  const q = useQuery({
    queryKey: ["sa-ai-activity", filters],
    queryFn: () => api.superAdminAiActivity({ ...filters, limit: 300 }),
  });
  const items = q.data?.items ?? [];

  const apply = () =>
    setFilters({
      org: org.trim() || undefined,
      user: userQ.trim() || undefined,
      capability: capability.trim() || undefined,
      source: source.trim() || undefined,
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-content dark:text-mortar-200">
        Every AI call across all workspaces — the chat, Build, scan, summaries. Click a row for the full prompt + response.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <FilterInput label="Workspace (slug)" value={org} onChange={setOrg} placeholder="workshop-2e2d" />
        <FilterInput label="User (email contains)" value={userQ} onChange={setUserQ} placeholder="grace@" />
        <FilterInput label="Capability" value={capability} onChange={setCapability} placeholder="chat" />
        <FilterInput label="Source (kind contains)" value={source} onChange={setSource} placeholder="matchmaker" />
        <button onClick={apply} className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition">
          Filter
        </button>
        {(filters.org || filters.user || filters.capability || filters.source) && (
          <button onClick={() => { setOrg(""); setUserQ(""); setCapability(""); setSource(""); setFilters({}); }} className="text-xs text-faint hover:text-accent">
            clear
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 text-left">
              {["When", "Workspace", "User", "Capability", "Model", "Tokens", "Cost", "Source", ""].map((h) => (
                <th key={h} className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={`${c.org_id}:${c.id}`} className="border-b border-line dark:border-slate-800 last:border-0 hover:bg-subtle/40 dark:hover:bg-slate-800/30 cursor-pointer" onClick={() => setDetail(c)}>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{new Date(c.invoked_at).toLocaleString()}</td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200 whitespace-nowrap">{c.org_slug}</td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200 whitespace-nowrap">{c.user_email ?? <span className="text-faint italic">system</span>}</td>
                <td className="px-3 py-1.5"><span className="font-mono text-[11px]">{c.capability}</span></td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{c.model ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{(c.input_tokens ?? 0) + (c.output_tokens ?? 0) || "—"}</td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{c.cost_cents != null ? `$${(c.cost_cents / 100).toFixed(2)}` : "—"}</td>
                <td className="px-3 py-1.5 text-faint whitespace-nowrap">{c.cached ? "cache" : c.source_kind ?? "—"}{c.ok ? "" : " ⚠"}</td>
                <td className="px-3 py-1.5 text-right text-accent">view</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-faint italic">{q.isLoading ? "Loading…" : "No AI calls match."}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && <AiActivityDetailModal item={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function FilterInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input text-sm" />
    </label>
  );
}

function AiActivityDetailModal({ item, onClose }: { item: SuperAdminAiActivityItem; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["sa-ai-detail", item.org_id, item.id],
    queryFn: () => api.superAdminAiActivityDetail(item.org_id, item.id),
  });
  const d = q.data;
  return (
    <Modal open onClose={onClose} title={`AI call · ${item.capability}`} size="lg">
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2 text-xs text-muted">
          <div><span className="text-faint">Workspace:</span> {item.org_name} ({item.org_slug})</div>
          <div><span className="text-faint">User:</span> {item.user_email ?? "system"}</div>
          <div><span className="text-faint">Model:</span> {item.model ?? "—"} · {item.provider_id}</div>
          <div><span className="text-faint">When:</span> {new Date(item.invoked_at).toLocaleString()}</div>
          <div><span className="text-faint">Tokens:</span> {item.input_tokens ?? 0} in / {item.output_tokens ?? 0} out</div>
          <div><span className="text-faint">Cost:</span> {item.cost_cents != null ? `$${(item.cost_cents / 100).toFixed(2)}` : "—"}{item.cached ? " (cached)" : ""}</div>
        </div>
        {!d ? (
          <div className="text-faint text-xs">Loading full text…</div>
        ) : (
          <>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">Prompt</div>
              <pre className="text-xs whitespace-pre-wrap bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-64 overflow-auto text-content dark:text-mortar-200">{d.input_full ?? "(none)"}</pre>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">Response</div>
              <pre className="text-xs whitespace-pre-wrap bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-64 overflow-auto text-content dark:text-mortar-200">{d.output_full ?? (d.error ? `Error: ${d.error}` : "(none)")}</pre>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Scan Eval — captured matchmaker eval cases (P2 of the prompt-eval harness).
// Each row is a platform admin's corrected scan commit (input + menu the model
// saw + the route/fields they committed). The e2e import script pulls these into
// e2e/fixtures/scan-eval/ as golden cases. See docs/operations/ai-prompt-eval-harness.md.
// The public approval queue: corrections that UNTRUSTED instances proposed
// (verified=false). Approve → it becomes the verified answer for every workspace;
// reject → drop it. Needs COBBLR_BARCODE_RESOLVER_REVIEW_TOKEN on this instance.
function BarcodeReviewSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["sa-barcode-corrections"],
    queryFn: () => api.superAdminBarcodeCorrections(),
  });
  const items = q.data?.items ?? [];
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "verify" | "reject" }) =>
      action === "verify" ? api.superAdminVerifyBarcodeCorrection(id) : api.superAdminRejectBarcodeCorrection(id),
    onSuccess: (_d, v) => {
      toast.success(v.action === "verify" ? "Approved — now the answer for every workspace" : "Rejected");
      void qc.invalidateQueries({ queryKey: ["sa-barcode-corrections"] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  if (q.error) {
    return (
      <p className="text-sm text-faint">
        Review queue unavailable — this instance has no <code>COBBLR_BARCODE_RESOLVER_REVIEW_TOKEN</code> set.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        User-proposed corrections from untrusted instances (e.g. public scans). Approve to make it the
        verified answer every workspace's next scan sees; reject to drop it.
      </p>
      {q.isLoading && <p className="text-sm text-faint">loading…</p>}
      {!q.isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-faint">
          No proposed corrections to review.
        </div>
      )}
      {items.map((c) => {
        const cur =
          c.field === "title" ? c.current.title : c.field === "brand" ? c.current.brand : c.field === "category" ? c.current.category : null;
        return (
          <div key={c.id} className="rounded-lg border border-line dark:border-slate-700 p-3 flex items-start gap-3 text-sm">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-mono text-[11px] text-muted">
                {c.upc} · {c.field} · {new Date(c.created_at).toLocaleString()}
                {c.source_context ? ` · ${c.source_context}` : ""}
              </div>
              <div className="text-faint line-through truncate">{cur ?? (c.current.provider_found ? "—" : "(providers found nothing)")}</div>
              <div className="text-content dark:text-mortar-100 font-medium truncate">→ {String(c.proposed_value)}</div>
              {c.reason && <div className="text-xs text-muted">“{c.reason}”</div>}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                disabled={act.isPending}
                onClick={() => act.mutate({ id: c.id, action: "verify" })}
                className="rounded bg-moss-600 hover:bg-moss-700 text-white text-xs px-2.5 py-1.5 transition disabled:opacity-50"
              >
                Approve
              </button>
              <button
                disabled={act.isPending}
                onClick={() => act.mutate({ id: c.id, action: "reject" })}
                className="rounded border border-line dark:border-slate-700 text-faint hover:text-red-500 text-xs px-2.5 py-1.5 transition disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BarcodeCacheTab() {
  const [layer, setLayer] = useState<"shared" | "workspaces" | "review">("shared");
  const [qText, setQText] = useState("");
  const [org, setOrg] = useState("");
  const [source, setSource] = useState("");
  const [foundSel, setFoundSel] = useState<"" | "true" | "false">("");
  const [filters, setFilters] = useState<{ q?: string; org?: string; source?: string; found?: boolean }>({});
  const [detail, setDetail] = useState<SuperAdminBarcodeCacheItem | null>(null);

  const q = useQuery({
    queryKey: ["sa-barcode-cache", layer, filters],
    queryFn: () => api.superAdminBarcodeCache({ ...filters, layer: layer as "shared" | "workspaces", limit: 300 }),
    enabled: layer !== "review",
  });
  const items = q.data?.items ?? [];

  const apply = () =>
    setFilters({
      q: qText.trim() || undefined,
      org: org.trim() || undefined,
      source: source.trim() || undefined,
      found: foundSel === "" ? undefined : foundSel === "true",
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-content dark:text-mortar-200">
        The per-UPC lookup cache scans build up. <b>Instance-wide</b> is the deduped shared layer —
        each barcode is resolved once for the whole platform (go-upc first, then
        upcitemdb/Open&nbsp;Products&nbsp;Facts) and served from here to every workspace after.
        <b> Per-workspace</b> shows the local mirrors: who scanned what, where. Click a row for every
        field we captured, including the raw provider payload.
      </p>
      <div className="inline-flex rounded-lg border border-line dark:border-slate-700 overflow-hidden text-xs">
        {([["shared", "Instance-wide (deduped)"], ["workspaces", "Per-workspace mirrors"], ["review", "Proposed corrections"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setLayer(id)}
            className={
              "px-3 py-1.5 font-medium transition " +
              (layer === id
                ? "bg-cobble-600 text-white"
                : "bg-surface dark:bg-slate-900 text-muted hover:text-accent")
            }
          >
            {label}
          </button>
        ))}
      </div>
      {layer === "review" && <BarcodeReviewSection />}
      {layer !== "review" && (<>
      <div className="flex flex-wrap items-end gap-2">
        <FilterInput label="Search (UPC / title / brand)" value={qText} onChange={setQText} placeholder="784297 or southwire" />
        {layer === "workspaces" && (
          <FilterInput label="Workspace (slug)" value={org} onChange={setOrg} placeholder="log-it-or-frog-it" />
        )}
        <FilterInput label="Source" value={source} onChange={setSource} placeholder="go-upc" />
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-muted">
          Result
          <select
            value={foundSel}
            onChange={(e) => setFoundSel(e.target.value as "" | "true" | "false")}
            className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-2 text-sm text-content dark:text-mortar-100"
          >
            <option value="">all</option>
            <option value="true">hits</option>
            <option value="false">misses</option>
          </select>
        </label>
        <button onClick={apply} className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition">
          Filter
        </button>
        {(filters.q || filters.org || filters.source || filters.found !== undefined) && (
          <button onClick={() => { setQText(""); setOrg(""); setSource(""); setFoundSel(""); setFilters({}); }} className="text-xs text-faint hover:text-accent">
            clear
          </button>
        )}
      </div>

      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 text-left">
              {["", "UPC", "Product", "Brand", "Category", "Source", ...(layer === "workspaces" ? ["Workspace"] : []), "Result", "When"].map((h, i) => (
                <th key={i} className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr
                key={`${c.org_id}:${c.upc}`}
                className="border-b border-line dark:border-slate-800 last:border-0 hover:bg-subtle/40 dark:hover:bg-slate-800/30 cursor-pointer"
                onClick={() => setDetail(c)}
              >
                <td className="px-3 py-1.5">
                  {c.image_url ? (
                    <img src={c.image_url} alt="" className="w-8 h-8 rounded object-cover border border-line dark:border-slate-700" loading="lazy" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-subtle dark:bg-slate-800" />
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-content dark:text-mortar-200 whitespace-nowrap">{c.upc}</td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-100 max-w-[28rem] truncate">{c.title ?? <span className="text-faint">—</span>}</td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{c.brand ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted max-w-[12rem] truncate">{c.category ?? "—"}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <span className="rounded-full border border-line dark:border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-muted">{c.source}</span>
                </td>
                {layer === "workspaces" && (
                  <td className="px-3 py-1.5 text-muted whitespace-nowrap">{c.org_slug}</td>
                )}
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {c.found ? (
                    <span className="text-moss-600 dark:text-moss-400 font-medium">hit</span>
                  ) : (
                    <span className="text-faint">miss</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap">{new Date(c.fetched_at).toLocaleString()}</td>
              </tr>
            ))}
            {!q.isLoading && items.length === 0 && (
              <tr><td colSpan={layer === "workspaces" ? 9 : 8} className="px-3 py-6 text-center text-faint">Nothing cached yet — scan something.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      </>)}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.title ?? detail?.upc ?? ""} size="lg">
        {detail && (
          <div className="space-y-3 text-sm">
            <div className="flex gap-4">
              {detail.image_url && (
                <img src={detail.image_url} alt="" className="w-28 h-28 rounded-lg object-cover border border-line dark:border-slate-700 shrink-0" />
              )}
              <div className="space-y-1 min-w-0">
                {([
                  ["UPC", detail.upc],
                  ["Brand", detail.brand],
                  ["Model", detail.model],
                  ["Category", detail.category],
                  ["Source", detail.source],
                  ...(detail.org_slug ? ([["Workspace", `${detail.org_name} (${detail.org_slug})`]] as Array<[string, string | null]>) : []),
                  ["Result", detail.found ? "hit" : "miss"],
                  ["Fetched", new Date(detail.fetched_at).toLocaleString()],
                  ...(detail.expires_at ? ([["Re-check after", new Date(detail.expires_at).toLocaleString()]] as Array<[string, string | null]>) : []),
                ] as Array<[string, string | null]>).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted pt-0.5">{k}</span>
                    <span className="text-content dark:text-mortar-100 break-all">{v ?? "—"}</span>
                  </div>
                ))}
              </div>
            </div>
            {detail.description && (
              <p className="text-muted dark:text-slate-300">{detail.description}</p>
            )}
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted mb-1">Raw provider payload (everything captured)</div>
              <pre className="rounded-md border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-900 p-3 text-[11px] overflow-auto max-h-72 whitespace-pre-wrap break-all">
                {JSON.stringify(detail.raw, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ScanEvalTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [detail, setDetail] = useState<ScanEvalCase | null>(null);

  const q = useQuery({ queryKey: ["sa-scan-eval-cases"], queryFn: () => api.listScanEvalCases() });
  const items = q.data?.items ?? [];

  const del = useMutation({
    mutationFn: (c: ScanEvalCase) => api.deleteScanEvalCase(c.org_id, c.id),
    onSuccess: () => {
      toast.success("Eval case deleted");
      void qc.invalidateQueries({ queryKey: ["sa-scan-eval-cases"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const routeStr = (c: ScanEvalCase) =>
    `${c.expected.route.module}${c.expected.route.instance ? `/${c.expected.route.instance}` : " (default)"}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-content dark:text-mortar-200">
        Captured matchmaker eval cases — a corrected scan commit recorded as a golden answer.
        Pull them into the harness fixtures with{" "}
        <code className="font-mono text-xs">node e2e/scan-eval-import.mjs</code>.
      </p>
      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40 text-left">
              {["When", "Workspace", "Item", "Route", "Fields", "Note", ""].map((h) => (
                <th key={h} className="px-3 py-1.5 font-mono text-[10px] uppercase text-muted tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={`${c.org_id}:${c.id}`} className="border-b border-line dark:border-slate-800 last:border-0 hover:bg-subtle/40 dark:hover:bg-slate-800/30">
                <td className="px-3 py-1.5 text-muted whitespace-nowrap cursor-pointer" onClick={() => setDetail(c)}>{new Date(c.created_at).toLocaleString()}</td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200 whitespace-nowrap cursor-pointer" onClick={() => setDetail(c)}>{c.org_slug}</td>
                <td className="px-3 py-1.5 text-content dark:text-mortar-200 cursor-pointer" onClick={() => setDetail(c)}>{c.expected.name ?? c.perceived_input.name ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap cursor-pointer" onClick={() => setDetail(c)}>{routeStr(c)}</td>
                <td className="px-3 py-1.5 text-muted whitespace-nowrap cursor-pointer" onClick={() => setDetail(c)}>{Object.keys(c.expected.fields ?? {}).length}</td>
                <td className="px-3 py-1.5 text-faint whitespace-nowrap cursor-pointer" onClick={() => setDetail(c)}>{c.note ?? ""}</td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <button
                    onClick={async () => {
                      if (await confirm({ title: "Delete eval case?", message: "This removes the captured case. It does not affect the committed entity.", destructive: true })) del.mutate(c);
                    }}
                    className="text-faint hover:text-red-500"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-4 text-center text-faint italic">{q.isLoading ? "Loading…" : "No eval cases captured yet — tick “Save as eval case” on a scan commit."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {detail && <ScanEvalDetailModal c={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ScanEvalDetailModal({ c, onClose }: { c: ScanEvalCase; onClose: () => void }) {
  const block = (label: string, value: unknown) => (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">{label}</div>
      <pre className="text-xs whitespace-pre-wrap bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-56 overflow-auto text-content dark:text-mortar-200">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
  return (
    <Modal open onClose={onClose} title={`Eval case · ${c.expected.name ?? c.perceived_input.name ?? "scan"}`} size="lg">
      <div className="space-y-3 text-sm">
        <div className="text-xs text-muted">
          <span className="text-faint">Workspace:</span> {c.org_name} ({c.org_slug}) · <span className="text-faint">captured</span> {new Date(c.created_at).toLocaleString()}
          {c.note ? <> · <span className="text-faint">note:</span> {c.note}</> : null}
        </div>
        {block("Perceived input (what the scanner saw)", c.perceived_input)}
        {block("Expected (the corrected commit = ground truth)", c.expected)}
        {block("Candidates the model proposed", c.candidates)}
        {block("Scan menu (the tables the model chose among)", c.scan_menu)}
      </div>
    </Modal>
  );
}

// Announcements → Discord. Per-category toggles so noteworthy platform events
// (new/resolved feedback, bundle releases, feature updates) post to a channel —
// each silenceable (e.g. to avoid doubling a separate commit feed).
function AnnouncementsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["sa-announce"],
    queryFn: () => api.listAnnounceSettings(),
  });
  const update = useMutation({
    mutationFn: ({ key, body }: { key: string; body: { enabled?: boolean; webhook_url?: string | null } }) =>
      api.setAnnounceSetting(key, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["sa-announce"] }),
    onError: () => toast.error("Couldn't update."),
  });
  const items = q.data?.items ?? [];
  const noDefault = items.length > 0 && !items[0]!.default_channel_set;
  const composable = items.filter((a) => a.composable);

  const [postCat, setPostCat] = useState("");
  const [postTitle, setPostTitle] = useState("");
  const [postBody, setPostBody] = useState("");
  const post = useMutation({
    mutationFn: () => api.postAnnouncement({ category: postCat, title: postTitle.trim(), body: postBody.trim() || undefined }),
    onSuccess: () => {
      toast.success("Posted to Discord.");
      setPostTitle("");
      setPostBody("");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't post."),
  });
  // Default the composer category to the first composable one.
  if (!postCat && composable.length > 0) setPostCat(composable[0]!.key);

  return (
    <div className="space-y-3">
      <p className="text-sm text-content dark:text-mortar-200">
        Post noteworthy platform events to Discord. Each category is independently
        toggleable — silence one if it doubles up with another feed. A category
        with no channel override uses the default{" "}
        <code className="font-mono text-xs">COBBLR_FEEDBACK_DISCORD_WEBHOOK</code>.
      </p>

      {/* Curated composer — post a bundle release / feature note on demand. */}
      {composable.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (postTitle.trim()) post.mutate();
          }}
          className="rounded-xl border border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/40 p-3 space-y-2"
        >
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent">post an update</div>
          <div className="flex gap-2">
            <select
              value={postCat}
              onChange={(e) => setPostCat(e.target.value)}
              className="text-sm rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5"
            >
              {composable.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
            <input
              value={postTitle}
              onChange={(e) => setPostTitle(e.target.value)}
              placeholder="Title — e.g. “📦 New: Yarn bundle v0.4”"
              className="flex-1 text-sm rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5"
            />
          </div>
          <textarea
            value={postBody}
            onChange={(e) => setPostBody(e.target.value)}
            rows={2}
            placeholder="Optional details…"
            className="w-full text-sm rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!postTitle.trim() || post.isPending}
              className="text-xs px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
            >
              {post.isPending ? "Posting…" : "Post to channel"}
            </button>
          </div>
        </form>
      )}
      {noDefault && (
        <div className="text-xs text-ember-500">
          No default Discord channel is set (COBBLR_FEEDBACK_DISCORD_WEBHOOK). Set
          it, or give each enabled category its own webhook below, or nothing posts.
        </div>
      )}
      {q.isLoading && <div className="text-sm text-faint">loading…</div>}
      <ul className="space-y-2">
        {items.map((a) => (
          <li
            key={a.key}
            className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex items-start gap-3"
          >
            <label className="relative inline-flex items-center cursor-pointer mt-0.5 shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={a.enabled}
                onChange={(e) => update.mutate({ key: a.key, body: { enabled: e.target.checked } })}
              />
              <span className="w-9 h-5 rounded-full bg-line dark:bg-slate-700 peer-checked:bg-cobble-600 transition relative after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
            </label>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100">
                {a.label}{" "}
                <span className="font-mono text-[10px] text-faint">{a.key}</span>
              </div>
              <div className="text-xs text-muted dark:text-slate-400">{a.description}</div>
              <input
                defaultValue={a.webhook_url ?? ""}
                placeholder="channel webhook override (blank = default channel)"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === (a.webhook_url ?? "")) return;
                  update.mutate({ key: a.key, body: { webhook_url: v || null } });
                }}
                className="mt-1.5 w-full text-xs font-mono rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FEEDBACK_STATUSES = ["new", "triaged", "in_progress", "awaiting_decision", "backlog", "resolved", "wontfix"] as const;
const FEEDBACK_FILTERS = ["all", ...FEEDBACK_STATUSES] as const;
// `awaiting_decision` = the autopilot posted a spec/question card; OPEN + in the
// working queue (not hidden in backlog) until the author picks Build/Pursue/Pass/Backlog.
const FEEDBACK_STATUS_LABEL: Record<string, string> = { awaiting_decision: "awaiting you" };
const fbStatusLabel = (s: string) => FEEDBACK_STATUS_LABEL[s] ?? s.replace(/_/g, " ");
const FEEDBACK_SORTS = ["priority", "recent"] as const;
type FeedbackSort = (typeof FEEDBACK_SORTS)[number];
const FEEDBACK_FILTER_KEY = "cobblr.admin.feedback.filter";
const FEEDBACK_SORT_KEY = "cobblr.admin.feedback.sort";

function loadFeedbackFilter(): string {
  const v = localStorage.getItem(FEEDBACK_FILTER_KEY);
  return v && (FEEDBACK_FILTERS as readonly string[]).includes(v) ? v : "new";
}
function loadFeedbackSort(): FeedbackSort {
  const v = localStorage.getItem(FEEDBACK_SORT_KEY);
  return v && (FEEDBACK_SORTS as readonly string[]).includes(v) ? (v as FeedbackSort) : "priority";
}

// Feedback triage queue — what users submit via the FeedbackWidget lands here.
function FeedbackTab() {
  const qc = useQueryClient();
  const toast = useToast();
  // Persist the filter/sort selection so it survives a refresh (reported bug).
  const [filter, setFilter] = useState<string>(loadFeedbackFilter);
  const [sort, setSort] = useState<FeedbackSort>(loadFeedbackSort);
  useEffect(() => {
    localStorage.setItem(FEEDBACK_FILTER_KEY, filter);
  }, [filter]);
  useEffect(() => {
    localStorage.setItem(FEEDBACK_SORT_KEY, sort);
  }, [sort]);
  const q = useQuery({
    queryKey: ["sa-feedback", filter, sort],
    queryFn: () => api.listFeedback(filter === "all" ? undefined : filter, sort),
  });
  const update = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        status?: string;
        admin_notes?: string | null;
        notify_reporter?: boolean;
        reply_message?: string;
        public_summary?: string;
      };
    }) => api.updateFeedback(id, body),
    onSuccess: (res, vars) => {
      void qc.invalidateQueries({ queryKey: ["sa-feedback"] });
      if (vars.body.notify_reporter) {
        toast[res.notified ? "success" : "error"](
          res.notified
            ? res.emailed
              ? "Reporter notified + emailed."
              : "Reporter notified."
            : "Couldn't notify — reporter has no workspace.",
        );
      }
    },
    onError: () => toast.error("Update failed."),
  });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 text-xs font-mono flex-wrap">
        {FEEDBACK_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={
              "px-2 py-1 rounded transition " +
              (filter === s
                ? "bg-cobble-100 text-accent dark:bg-cobble-700 dark:text-mortar-100"
                : "text-faint hover:text-accent")
            }
          >
            {fbStatusLabel(s)}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-faint dark:text-slate-500">sort</span>
        {FEEDBACK_SORTS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSort(s)}
            className={
              "px-2 py-1 rounded transition " +
              (sort === s
                ? "bg-cobble-100 text-accent dark:bg-cobble-700 dark:text-mortar-100"
                : "text-faint hover:text-accent")
            }
          >
            {s}
          </button>
        ))}
      </div>
      {q.isLoading && <div className="text-xs text-faint">loading…</div>}
      {items.length === 0 && !q.isLoading && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No feedback{filter !== "all" ? ` with status "${filter}"` : " yet"}.
        </div>
      )}
      <ul className="space-y-3">
        {items.map((f) => (
          <FeedbackCard key={f.id} f={f} onUpdate={(body) => update.mutate({ id: f.id, body })} />
        ))}
      </ul>
    </div>
  );
}

const PRIORITY_CHIP: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

function PriorityChip({ priority }: { priority: "urgent" | "high" | "medium" | "low" }) {
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded font-mono uppercase text-[10px] font-semibold " +
        (PRIORITY_CHIP[priority] ?? PRIORITY_CHIP.low)
      }
    >
      {priority}
    </span>
  );
}

function ValidViableChip({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return null;
  return (
    <span className={ok ? "text-moss-600 dark:text-moss-400" : "text-red-500 dark:text-red-400"}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

// A reporter-attached screenshot: thumbnail in the card, click to enlarge. The
// image routes through useImageSrc (Bearer → blob) since the raw endpoint is
// auth-gated; one `medium` fetch serves both the thumb and the lightbox.
function FeedbackShot({ feedbackId, fileId, name }: { feedbackId: string; fileId: string; name?: string }) {
  const [zoom, setZoom] = useState(false);
  const src = useImageSrc(api.feedbackAttachmentRawUrl(feedbackId, fileId, "medium"));
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        title={name || "screenshot"}
        className="w-16 h-16 rounded-md overflow-hidden border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800"
      >
        {src ? (
          <img src={src} alt={name || "screenshot"} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-faint">…</div>
        )}
      </button>
      <Modal open={zoom} onClose={() => setZoom(false)} title={name || "Screenshot"} size="lg">
        {src ? (
          <img src={src} alt={name || "screenshot"} className="max-h-[70vh] w-auto mx-auto rounded" />
        ) : (
          <div className="text-xs text-faint p-8 text-center">loading…</div>
        )}
      </Modal>
    </>
  );
}

function FeedbackCard({
  f,
  onUpdate,
}: {
  f: FeedbackItem;
  onUpdate: (body: {
    status?: string;
    admin_notes?: string | null;
    notify_reporter?: boolean;
    reply_message?: string;
    public_summary?: string;
  }) => void;
}) {
  const [notes, setNotes] = useState(f.admin_notes ?? "");
  const [reply, setReply] = useState("");
  // Third-person "what we fixed" note for the Discord feedback-resolved post.
  const [publicSummary, setPublicSummary] = useState("");
  const ctx = (f.context ?? {}) as { url?: string; route?: string };
  const emoji = f.type === "bug" ? "🐛" : f.type === "confusing" ? "😕" : f.type === "idea" ? "💡" : "•";
  return (
    <li className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span>
          {emoji} <span className="font-mono uppercase text-accent">{f.type}</span>
        </span>
        {f.triage_priority && <PriorityChip priority={f.triage_priority} />}
        {f.origin === "discord" && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
            discord
          </span>
        )}
        <span className="text-faint dark:text-slate-500">
          {f.user_name || f.user_email || f.origin_ref?.username || "?"}
        </span>
        {f.workspace_slug && (
          <span className="text-faint dark:text-slate-500">· {f.workspace_name || f.workspace_slug}</span>
        )}
        <span className="text-faint dark:text-slate-500">· {new Date(f.created_at).toLocaleString()}</span>
        <div className="flex-1" />
        <select
          value={f.status}
          onChange={(e) =>
            onUpdate({
              status: e.target.value,
              // On resolve, carry the "what we fixed" note into the Discord post.
              ...(e.target.value === "resolved" && publicSummary.trim()
                ? { public_summary: publicSummary.trim() }
                : {}),
            })
          }
          className="text-xs rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-1 py-0.5"
        >
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {fbStatusLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="text-content dark:text-mortar-100 whitespace-pre-wrap">{f.message}</div>
      {ctx.route && (
        <div className="text-[10px] font-mono text-faint dark:text-slate-500 break-all">@ {ctx.route}</div>
      )}
      {f.attachments?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {f.attachments.map((a) => (
            <FeedbackShot key={a.file_id} feedbackId={f.id} fileId={a.file_id} name={a.name} />
          ))}
        </div>
      )}
      {f.followups?.length > 0 && (
        <div className="border-l-2 border-indigo-300 dark:border-indigo-700 pl-2.5 space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-wide text-faint dark:text-slate-500">
            💬 {f.followups.length} follow-up{f.followups.length === 1 ? "" : "s"}
          </div>
          {f.followups.map((fu, i) => (
            <div key={i} className="text-xs">
              <span className="text-faint dark:text-slate-500">{fu.from}: </span>
              <span className="text-content dark:text-mortar-200 whitespace-pre-wrap">{fu.text}</span>
              {fu.images?.map((img, j) => (
                <a
                  key={j}
                  href={img.url && /^https?:\/\//i.test(img.url) ? img.url : undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1.5 text-accent hover:underline"
                >
                  🖼 {img.name || "image"}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
      {f.triaged_at && (
        <div className="rounded-lg border border-line/70 dark:border-slate-800 bg-subtle/60 dark:bg-slate-800/40 p-2.5 space-y-1.5">
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wide text-faint dark:text-slate-500">
            <span>🤖 AI triage</span>
            <ValidViableChip ok={f.triage_valid} label="valid" />
            <ValidViableChip ok={f.triage_viable} label="viable" />
            {f.triage_model && <span className="text-faint/70">· {f.triage_model}</span>}
          </div>
          {f.triage_summary && (
            <div className="text-xs text-content dark:text-mortar-200">{f.triage_summary}</div>
          )}
          {f.triage_action && (
            <div className="text-xs text-faint dark:text-slate-400">
              <span className="font-medium text-accent">→ </span>
              {f.triage_action}
            </div>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={1}
          placeholder="triage notes…"
          className="flex-1 text-xs rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
        />
        <button
          type="button"
          onClick={() => onUpdate({ admin_notes: notes })}
          className="text-xs px-2 py-1 rounded bg-cobble-600 hover:bg-cobble-700 text-white"
        >
          save note
        </button>
      </div>
      {/* Close the loop with the reporter — sends them an in-app notification
          ("we fixed it" / "we're looking into it"). Empty reply = a default
          keyed off the current status. */}
      <div className="flex items-end gap-2 border-t border-line/60 dark:border-slate-800 pt-2">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={`reply to ${f.user_name || f.user_email || f.origin_ref?.username || "the reporter"} ${f.origin === "discord" ? "(in Discord thread)" : "(in-app)"}…`}
          className="flex-1 text-xs rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
        />
        <button
          type="button"
          onClick={() => {
            onUpdate({
              notify_reporter: true,
              reply_message: reply.trim() || undefined,
              status: f.status,
            });
            setReply("");
          }}
          className="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white whitespace-nowrap"
          title="Send the reporter an in-app notification. Uses your reply, or a default based on the current status."
        >
          notify reporter
        </button>
      </div>
      {/* Public "what we fixed" note — third-person; posted to the Discord
          feedback channel when you set status → resolved. Not sent to the reporter. */}
      <input
        value={publicSummary}
        onChange={(e) => setPublicSummary(e.target.value)}
        placeholder="what we fixed (third-person — posts to Discord on resolve)…"
        className="w-full text-xs rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/70 px-2 py-1 text-content dark:text-mortar-200"
      />
    </li>
  );
}

// ── Product Metrics — the thesis dashboard (audit F2) ────────────────────────
// Walls-hit-per-week per workspace (permission_denied / validation_rejected /
// wire failures) + time-to-first-working-app. The strategy docs' north star:
// walls/week trending to ZERO for a genuine non-dev workspace is the proof.
// Founder-owned workspaces should be read with the founder-proxy trap in mind.
function ProductMetricsTab() {
  const q = useQuery({
    queryKey: ["super-admin-product-metrics"],
    queryFn: () => api.superAdminProductMetrics(),
    refetchInterval: 60_000,
  });
  const ws = [...(q.data?.workspaces ?? [])].sort((a, b) => b.walls_7d - a.walls_7d);
  const fmtTtfw = (m: number | null) =>
    m === null ? "—" : m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        The thesis, measured: <b>walls hit</b> (permission denials, artifacts that failed
        validation, wires that errored or cycled) per workspace, and <b>time to first working
        app</b> (signup → first real item). The goal is walls/week trending to zero for
        genuine non-dev workspaces — your own workspaces don't count as proof.
        Interpretation notes: docs/operations/product-metrics.md.
      </p>
      {q.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : ws.length === 0 ? (
        <div className="text-sm text-muted">No workspaces yet.</div>
      ) : (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-subtle/50 dark:bg-slate-800/40">
              <tr>
                <Th>Workspace</Th>
                <Th>Created</Th>
                <Th>First item (TTFW)</Th>
                <Th>Walls 7d</Th>
                <Th>Walls 30d</Th>
                <Th>What they hit (7d)</Th>
              </tr>
            </thead>
            <tbody>
              {ws.map((w) => (
                <tr key={w.org_id} className="border-t border-line dark:border-slate-700 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-content dark:text-mortar-100">{w.name}</div>
                    <div className="text-xs text-muted font-mono">{w.slug}</div>
                  </td>
                  <td className="px-3 py-2">{new Date(w.created_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    {w.first_item_at ? (
                      <span title={new Date(w.first_item_at).toLocaleString()}>{fmtTtfw(w.ttfw_minutes)}</span>
                    ) : (
                      <span className="text-muted" title="Never committed an item — the other half of the thesis">
                        never
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={w.walls_7d > 0 ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted"}>
                      {w.walls_7d}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted">{w.walls_30d}</td>
                  <td className="px-3 py-2">
                    {w.walls.filter((x) => x.d7 > 0).length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {w.walls
                          .filter((x) => x.d7 > 0)
                          .map((x) => (
                            <span
                              key={x.event}
                              className="inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-600 px-2 py-0.5 text-xs"
                            >
                              {x.event} <b>{x.d7}</b>
                            </span>
                          ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
