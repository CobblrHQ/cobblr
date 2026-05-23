// Dashboard — landing page once authed. Shows what's actually IN
// this workspace, not what could be in any workspace. Three bands:
//
//   1. Header strip — workspace name + at-a-glance count chips that
//      only render for the modules that workspace has enabled.
//   2. Quick-look tiles — one per enabled user-facing module, with
//      the one number that matters there (total / open / blocked /
//      low-stock) and a click-through to the module page.
//   3. Pinned saved views — actually render the first ~2 views the
//      user saved, with the first 5 items each. Not a link to the
//      Views page; the data itself.
//   4. Recent activity — last 10 actions, formatted with actor +
//      entity title (from the diff blob) instead of raw type names.
//
// All per-module queries are gated by the orgModules() result so a
// workspace with only inventory + labels enabled doesn't ping
// /projects/tasks?blocked=1 and 404. Each query stays cached for
// 30s so navigating away + back doesn't refire everything.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Boxes,
  LayoutList,
  ListChecks,
  Package,
  ShoppingCart,
  Sprout,
  Tags,
  Wrench,
} from "lucide-react";
import {
  EntityThumb,
  EntityTile,
  ViewModeToggle,
  useViewMode,
} from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import {
  api,
  type ActivityEntry,
  type OrgModuleListItem,
  type SavedView,
} from "../lib/api";

export function Dashboard() {
  const { user } = useAuth();
  const { activeOrg, activeSlug } = useActiveOrg();
  if (!activeOrg || !activeSlug) return null;

  // The org's enabled modules — every per-module query below gates
  // off this so we don't ping endpoints whose router isn't mounted.
  const modulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    staleTime: 30_000,
  });
  const enabled = new Set(
    (modulesQ.data?.items ?? [])
      .filter((m) => m.enabled)
      .map((m) => m.name),
  );

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        orgName={activeOrg.name}
        slug={activeSlug}
        role={activeOrg.role}
        userName={user?.display_name ?? user?.email ?? ""}
      />

      <ModuleTiles slug={activeSlug} enabled={enabled} />

      <PinnedViews slug={activeSlug} />

      <RecentActivity slug={activeSlug} />
    </div>
  );
}

// ──────────────────────── workspace header ─────────────────────────

function WorkspaceHeader({
  orgName,
  slug,
  role,
  userName,
}: {
  orgName: string;
  slug: string;
  role: string;
  userName: string;
}) {
  return (
    <header className="rounded-xl border border-slate-200 dark:border-slate-700 bg-gradient-to-br from-cobble-50/40 to-white dark:from-slate-900 dark:to-slate-900/40 p-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase tracking-tight">
          {orgName}
        </h1>
        <span className="text-xs font-mono text-slate-400 dark:text-slate-500">
          {slug}
        </span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-100 dark:bg-cobble-900/30 text-cobble-700 dark:text-cobble-300">
          {role}
        </span>
        <div className="flex-1" />
        <span className="text-xs text-slate-500 dark:text-slate-400">
          welcome back, {userName.split(" ")[0]}
        </span>
      </div>
    </header>
  );
}

// ────────────────────────── module tiles ────────────────────────────

function ModuleTiles({
  slug,
  enabled,
}: {
  slug: string;
  enabled: Set<string>;
}) {
  const tiles: React.ReactNode[] = [];
  if (enabled.has("inventory")) {
    tiles.push(<InventoryTile key="inv" slug={slug} />);
  }
  if (enabled.has("machines")) {
    tiles.push(<MachinesTile key="mac" slug={slug} />);
  }
  if (enabled.has("projects")) {
    tiles.push(<ProjectsTile key="prj" slug={slug} />);
  }
  if (enabled.has("assets")) {
    tiles.push(<AssetsTile key="ast" slug={slug} />);
  }
  if (enabled.has("purchases")) {
    tiles.push(<PurchasesTile key="pur" slug={slug} />);
  }
  if (enabled.has("labels")) {
    tiles.push(<LabelsTile key="lbl" slug={slug} />);
  }
  if (tiles.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No user-facing modules enabled yet. Visit{" "}
        <Link to="/configuration" className="text-cobble-600 hover:underline">
          /configuration
        </Link>{" "}
        to add some.
      </section>
    );
  }
  return (
    <section>
      <SectionTitle>at a glance</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {tiles}
      </div>
    </section>
  );
}

// Per-module tiles. Each fetches one count (and a secondary signal
// where it matters) and renders a clickable card. Keep them visually
// uniform so the grid reads as a rhythm, not a smorgasbord.

function Tile({
  to,
  icon: Icon,
  label,
  primary,
  secondary,
  attention,
}: {
  to: string;
  icon: typeof Boxes;
  label: string;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  attention?: boolean;
}) {
  return (
    <Link
      to={to}
      className={
        "rounded-xl border bg-white dark:bg-slate-900 p-4 hover:border-cobble-300 dark:hover:border-cobble-700 transition flex flex-col gap-2 " +
        (attention
          ? "border-ember-300 dark:border-ember-700"
          : "border-slate-200 dark:border-slate-700")
      }
    >
      <div className="flex items-center gap-2">
        <Icon
          size={14}
          className={attention ? "text-ember-500" : "text-cobble-500"}
        />
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
          {label}
        </span>
      </div>
      <div className="text-3xl font-semibold text-slate-700 dark:text-mortar-100 leading-none">
        {primary}
      </div>
      {secondary && (
        <div className="text-[11px] text-slate-500 dark:text-slate-400">
          {secondary}
        </div>
      )}
    </Link>
  );
}

function InventoryTile({ slug }: { slug: string }) {
  const all = useQuery({
    queryKey: ["dash-inv-all", slug],
    queryFn: () =>
      api.request<{ items: unknown[] }>(
        "GET",
        `/orgs/${slug}/modules/inventory/parts?limit=200`,
      ),
    staleTime: 30_000,
  });
  const low = useQuery({
    queryKey: ["dash-inv-low", slug],
    queryFn: () =>
      api.request<{ items: unknown[] }>(
        "GET",
        `/orgs/${slug}/modules/inventory/parts?low_stock=1&limit=200`,
      ),
    staleTime: 30_000,
  });
  const total = all.data?.items.length ?? 0;
  const lowCount = low.data?.items.length ?? 0;
  return (
    <Tile
      to="/inventory"
      icon={Package}
      label="inventory"
      primary={total}
      secondary={
        lowCount > 0 ? (
          <span className="text-ember-600 dark:text-ember-500">
            {lowCount} low-stock
          </span>
        ) : (
          "all stocked"
        )
      }
      attention={lowCount > 0}
    />
  );
}

function MachinesTile({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-machines", slug],
    queryFn: () =>
      api.request<{ items: Array<{ state: string }> }>(
        "GET",
        `/orgs/${slug}/modules/machines/machines?limit=200`,
      ),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const states = items.reduce<Record<string, number>>((acc, m) => {
    acc[m.state] = (acc[m.state] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(states)
    .map(([s, n]) => `${n} ${s}`)
    .slice(0, 3)
    .join(" · ");
  return (
    <Tile
      to="/machines"
      icon={Wrench}
      label="machines"
      primary={items.length}
      secondary={breakdown || "none yet"}
    />
  );
}

function ProjectsTile({ slug }: { slug: string }) {
  const projects = useQuery({
    queryKey: ["dash-projects", slug],
    queryFn: () =>
      api.request<{ items: Array<{ status: string }> }>(
        "GET",
        `/orgs/${slug}/modules/projects/projects?limit=200`,
      ),
    staleTime: 30_000,
  });
  const blocked = useQuery({
    queryKey: ["dash-tasks-blocked", slug],
    queryFn: () =>
      api.request<{ items: unknown[] }>(
        "GET",
        `/orgs/${slug}/modules/projects/tasks?blocked=1&limit=200`,
      ),
    staleTime: 30_000,
  });
  const all = projects.data?.items ?? [];
  const active = all.filter((p) => p.status === "active").length;
  const blockedCount = blocked.data?.items.length ?? 0;
  return (
    <Tile
      to="/projects"
      icon={ListChecks}
      label="projects"
      primary={active}
      secondary={
        blockedCount > 0 ? (
          <span className="text-ember-600 dark:text-ember-500">
            {blockedCount} blocked
          </span>
        ) : (
          `${all.length} total`
        )
      }
      attention={blockedCount > 0}
    />
  );
}

function AssetsTile({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-assets", slug],
    queryFn: () =>
      api.request<{ items: Array<{ state: string }> }>(
        "GET",
        `/orgs/${slug}/modules/assets/assets?limit=200`,
      ),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const states = items.reduce<Record<string, number>>((acc, m) => {
    const k = m.state ?? "—";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const top = Object.entries(states).slice(0, 2).map(([s, n]) => `${n} ${s}`).join(" · ");
  return (
    <Tile
      to="/assets"
      icon={Sprout}
      label="assets"
      primary={items.length}
      secondary={top || "none yet"}
    />
  );
}

function PurchasesTile({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-orders", slug],
    queryFn: () =>
      api.request<{ items: Array<{ status: string }> }>(
        "GET",
        `/orgs/${slug}/modules/purchases/orders?limit=200`,
      ),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const open = items.filter(
    (o) => o.status !== "arrived" && o.status !== "cancelled",
  ).length;
  return (
    <Tile
      to="/purchases"
      icon={ShoppingCart}
      label="purchases"
      primary={open}
      secondary={open === items.length ? "all open" : `${items.length} total`}
    />
  );
}

function LabelsTile({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-labels", slug],
    queryFn: () =>
      api.request<{ items: unknown[] }>(
        "GET",
        `/orgs/${slug}/modules/labels/queue`,
      ),
    staleTime: 30_000,
  });
  const queued = q.data?.items.length ?? 0;
  return (
    <Tile
      to="/labels"
      icon={Tags}
      label="labels"
      primary={queued}
      secondary={queued === 0 ? "queue empty" : "in queue"}
    />
  );
}

// ──────────────────────── pinned saved views ────────────────────────

function PinnedViews({ slug }: { slug: string }) {
  const views = useQuery({
    queryKey: ["dash-views", slug],
    queryFn: () => api.listSavedViews(slug),
    staleTime: 30_000,
  });
  // Explicit user-pinned views (v0.3). Fall back to "first 2 shared
  // views" when nothing is pinned yet, so a fresh workspace still
  // shows something useful on the dashboard without first having
  // to go pin things.
  const allViews = views.data?.items ?? [];
  const explicitPinned = allViews.filter((v) => v.pinned);
  const pinned =
    explicitPinned.length > 0
      ? explicitPinned.slice(0, 4)
      : allViews.filter((v) => v.owner_user_id === null).slice(0, 2);
  const [mode, setMode] = useViewMode("dashboard-pinned-views", "list");
  if (pinned.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <SectionTitle>your views</SectionTitle>
        <div className="flex-1" />
        <ViewModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {pinned.map((v) => (
          <PinnedView key={v.id} slug={slug} view={v} mode={mode} />
        ))}
      </div>
    </section>
  );
}

function PinnedView({
  slug,
  view,
  mode,
}: {
  slug: string;
  view: SavedView;
  mode: "list" | "tiles";
}) {
  const data = useQuery({
    queryKey: ["dash-view-data", slug, view.id],
    queryFn: () => api.viewData(slug, view.id),
    staleTime: 30_000,
  });
  const items = (data.data?.items ?? []).slice(0, 5);
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-baseline gap-2 mb-2">
        <LayoutList size={13} className="text-cobble-500" />
        <Link
          to="/views"
          className="font-medium text-slate-700 dark:text-mortar-100 hover:text-cobble-600"
        >
          {view.name}
        </Link>
        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
          {view.view_type}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-slate-400">
          {data.data?.items.length ?? 0} rows
        </span>
      </div>
      {data.isLoading && (
        <div className="text-xs text-slate-400">loading…</div>
      )}
      {!data.isLoading && items.length === 0 && (
        <div className="text-xs text-slate-400 italic">no matching rows</div>
      )}
      {mode === "list" && (
        <ul className="space-y-1.5">
          {items.map((r) => (
            <li
              key={`${r.kind}:${r.id}`}
              className="flex items-center gap-3 text-sm"
            >
              <EntityThumb src={r.image_path} alt={r.title} size={40} />
              <div className="min-w-0">
                <div className="truncate text-slate-700 dark:text-mortar-100">
                  {r.title}
                </div>
                {r.subtitle && (
                  <div className="text-xs text-slate-500 truncate">
                    {r.subtitle}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {mode === "tiles" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {items.map((r) => (
            <EntityTile
              key={`${r.kind}:${r.id}`}
              src={r.image_path}
              title={r.title}
              subtitle={r.subtitle ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────── recent activity ───────────────────────────

function RecentActivity({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["dash-activity", slug],
    queryFn: () => api.orgActivity(slug, 10),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  return (
    <section>
      <SectionTitle>recent activity</SectionTitle>
      {q.isLoading && <div className="text-xs text-slate-400">loading…</div>}
      {!q.isLoading && items.length === 0 && (
        <div className="text-xs text-slate-400 italic">no activity yet</div>
      )}
      {items.length > 0 && (
        <ul className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((e) => (
            <ActivityRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({ entry: e }: { entry: ActivityEntry }) {
  // The diff blob usually carries the entity's title at create time.
  // Falls back to the bare entity_type when there's nothing to show.
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  const title =
    pickString(diff, ["name", "title", "label"]) ?? null;
  const action = humanAction(e.action);
  const actor = e.actor?.display_name ?? "someone";
  return (
    <li className="px-4 py-2 flex items-baseline gap-3 text-sm">
      <span className="text-slate-500 dark:text-slate-400 shrink-0">
        {actor}
      </span>
      <span className="text-slate-600 dark:text-mortar-200 shrink-0">
        {action}
      </span>
      <span className="text-slate-700 dark:text-mortar-100 truncate">
        {title ?? <span className="font-mono text-xs text-slate-400">{e.entity_type}</span>}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-slate-400 shrink-0">
        {relativeTime(e.occurred_at)}
      </span>
    </li>
  );
}

// ──────────────────────── tiny helpers ──────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
      // {children}
    </div>
  );
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function humanAction(a: string): string {
  // Cobblr's action names are snake_case verbs like 'task_created'
  // / 'pairing_created' / 'login'. Turn them into human prose.
  const map: Record<string, string> = {
    created: "created",
    updated: "updated",
    deleted: "deleted",
    login: "signed in",
    user_created: "joined",
    pairing_created: "linked",
    pairing_deleted: "unlinked",
  };
  if (map[a]) return map[a];
  // 'task_created' → 'created task' (the entity_type is already
  // rendered on the row, so we just need the verb).
  if (a.endsWith("_created")) return "created";
  if (a.endsWith("_updated")) return "updated";
  if (a.endsWith("_deleted")) return "deleted";
  return a.replace(/_/g, " ");
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Re-export for any callers still importing module item helpers from
// here. (Cleaned out the old WorkspaceCard / ModulesPanel / etc.
// implementations — they're not used now that this is the dashboard.)
export type { OrgModuleListItem };
