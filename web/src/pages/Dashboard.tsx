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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Eye, EyeOff, LayoutList, Sliders, Sparkles } from "lucide-react";
import { EntityThumb,
  EntityTile,
  ViewModeToggle,
  useViewMode, usePageTitle, useToast,
  useDashboardWidgets, type DashboardWidgetSpec } from "@cobblr/platform-web";
// Side-effect: registers the host's built-in "at a glance" widgets through
// the public registerDashboardWidget seam. ModuleTiles renders whatever's
// registered for an enabled module — no per-module knowledge in this file.
import "../dashboard/builtinWidgets";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import {
  api,
  type ActivityEntry,
  type DashboardLayout,
  type OrgModuleListItem,
  type SavedView,
} from "../lib/api";

export function Dashboard() {
  usePageTitle("Dashboard");
  const { user } = useAuth();
  const { activeOrg, activeSlug } = useActiveOrg();

  // The org's enabled modules — every per-module query below gates
  // off this so we don't ping endpoints whose router isn't mounted.
  // Query is unconditional + gated by `enabled` so React's hook
  // ordering stays stable across renders even when activeSlug is
  // briefly "" (right after auth, before ActiveOrgContext picks the
  // first org). The early-return-before-hooks pattern crashed the
  // page with React #310 on fresh logins; see _tmp/needs-your-check.md.
  const modulesQ = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    staleTime: 30_000,
    enabled: !!activeSlug,
  });
  const enabled = new Set(
    (modulesQ.data?.items ?? [])
      .filter((m) => m.enabled)
      .map((m) => m.name),
  );

  if (!activeOrg || !activeSlug) return null;

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        orgName={activeOrg.name}
        slug={activeSlug}
        role={activeOrg.role}
        userName={user?.display_name ?? user?.email ?? ""}
      />

      <CrossWorkspaceStrip />

      <GettingStartedPanel slug={activeSlug} enabled={enabled} />

      <ModuleTiles slug={activeSlug} enabled={enabled} role={activeOrg.role} />

      <PinnedViews slug={activeSlug} />

      <RecentActivity slug={activeSlug} />
    </div>
  );
}

// Empty-state onboarding. Shows when the active workspace has no
// entities across any of the user-facing modules — the dashboard
// would otherwise show a row of "0" tiles with no clear next step.
// Hides itself the moment any module gets its first entity.
function GettingStartedPanel({
  slug,
  enabled,
}: {
  slug: string;
  enabled: Set<string>;
}) {
  // One cheap probe per enabled module: any items at all?
  const probe = useQuery({
    queryKey: ["dash-getting-started", slug, Array.from(enabled).sort().join(",")],
    queryFn: async () => {
      const probes: Array<Promise<number>> = [];
      const wrap = (path: string) =>
        api
          .request<{ items: unknown[] }>("GET", `/orgs/${slug}${path}`)
          .then((r) => r.items.length)
          .catch(() => 0);
      if (enabled.has("inventory"))
        probes.push(wrap("/modules/inventory/parts?limit=1"));
      if (enabled.has("machines"))
        probes.push(wrap("/modules/machines/machines?limit=1"));
      if (enabled.has("assets")) probes.push(wrap("/modules/assets/assets?limit=1"));
      if (enabled.has("projects"))
        probes.push(wrap("/modules/projects/projects?limit=1"));
      if (enabled.has("purchases"))
        probes.push(wrap("/modules/purchases/orders?limit=1"));
      const counts = await Promise.all(probes);
      return counts.reduce((a, b) => a + b, 0);
    },
    enabled: enabled.size > 0,
    staleTime: 60_000,
  });

  // Don't render until we know whether the workspace is empty. Once
  // any entity exists, hide forever for this session.
  if (probe.data === undefined || probe.data > 0) return null;

  // Determine the most relevant "first thing to do" based on which
  // user-facing modules are enabled.
  const firstActions: Array<{ to: string; label: string; description: string }> = [];
  if (enabled.has("inventory"))
    firstActions.push({
      to: "/inventory",
      label: "Add a part",
      description: "Track inventory — sets, parts, supplies. Bulk import via CSV.",
    });
  if (enabled.has("machines"))
    firstActions.push({
      to: "/machines",
      label: "Add a machine",
      description: "Catalog tools, printers, equipment with photos + state.",
    });
  if (enabled.has("assets"))
    firstActions.push({
      to: "/assets",
      label: "Add an asset",
      description:
        "Plants, collectibles, anything you want to track over time. Watering RRULEs work out of the box.",
    });
  if (enabled.has("projects"))
    firstActions.push({
      to: "/projects",
      label: "Start a project",
      description: "Group tasks + cross-module dependencies under one heading.",
    });

  return (
    <section className="rounded-xl border-2 border-dashed border-cobble-300 dark:border-cobble-700 bg-cobble-50/30 dark:bg-cobble-900/10 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-accent" />
        <h2 className="font-semibold text-content dark:text-mortar-100">
          Welcome — this workspace is empty.
        </h2>
      </div>
      <p className="text-sm text-content dark:text-mortar-200">
        {firstActions.length > 0
          ? "Pick a first thing to add, or install a starter bundle from the marketplace."
          : "Nothing's installed yet — that's by design. Install a starter bundle from the marketplace, or switch on just the modules you want from Configuration. Cobblr only shows what you turn on."}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {firstActions.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-accent transition"
          >
            <div className="text-sm font-medium text-content dark:text-mortar-100">
              {a.label}
            </div>
            <div className="text-xs text-muted dark:text-slate-400 mt-0.5">
              {a.description}
            </div>
          </Link>
        ))}
        <Link
          to="/bundles"
          className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-accent transition"
        >
          <div className="text-sm font-medium text-content dark:text-mortar-100">
            Browse the marketplace
          </div>
          <div className="text-xs text-muted dark:text-slate-400 mt-0.5">
            One-click install of a starter pack — Lego, Garden, Tool
            Library, Bookshelf, more. Pre-built field defs + wires.
          </div>
        </Link>
        <Link
          to="/configuration"
          className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-accent transition"
        >
          <div className="text-sm font-medium text-content dark:text-mortar-100">
            Tune what's installed
          </div>
          <div className="text-xs text-muted dark:text-slate-400 mt-0.5">
            Enable / disable modules, tweak custom fields, wire
            up integrations.
          </div>
        </Link>
      </div>
    </section>
  );
}

// Cross-workspace summary strip — what's going on across EVERY
// workspace the user belongs to, even ones they're not currently
// looking at. Renders nothing when there's nothing to show, so a
// quiet account stays quiet.
function CrossWorkspaceStrip() {
  const { orgs } = useAuth();
  // Shared key with the NotificationsBell so React Query de-dupes
  // the call (was ["dash-cross-unread"] — separate from the bell's
  // ["me-notifications-unread"] — so the same endpoint was fetched
  // twice on every dashboard mount).
  const unread = useQuery({
    queryKey: ["me-notifications-unread"],
    queryFn: () => api.meNotificationsUnreadCount(),
    refetchInterval: 30_000,
  });
  const links = useQuery({
    queryKey: ["dash-cross-links"],
    queryFn: () => api.listWorkspaceLinks(),
    staleTime: 60_000,
  });
  const unreadCount = unread.data?.count ?? 0;
  const pending = (links.data?.items ?? []).filter((l) => l.status === "pending");
  if (orgs.length <= 1 && unreadCount === 0 && pending.length === 0) return null;

  return (
    <section className="flex items-center gap-3 flex-wrap text-sm">
      <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
        // across all workspaces
      </span>
      {orgs.length > 1 && (
        <span className="text-content dark:text-mortar-200">
          {orgs.length} workspaces
        </span>
      )}
      {unreadCount > 0 && (
        <Link
          to="/me/notifications"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-ember-200 dark:border-ember-700 text-ember-700 dark:text-ember-300 hover:bg-ember-50 dark:hover:bg-ember-900/20 text-xs transition"
        >
          {unreadCount} unread notification{unreadCount === 1 ? "" : "s"}
        </Link>
      )}
      {pending.length > 0 && (
        <Link
          to="/configuration/links"
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-cobble-200 dark:border-cobble-700 text-accent dark:text-cobble-300 hover:bg-cobble-50 dark:hover:bg-cobble-900/20 text-xs transition"
        >
          {pending.length} pending link{pending.length === 1 ? "" : "s"}
        </Link>
      )}
    </section>
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
    <header className="rounded-xl border border-line dark:border-slate-700 bg-gradient-to-br from-cobble-50/40 to-white dark:from-slate-900 dark:to-slate-900/40 p-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase tracking-tight">
          {orgName}
        </h1>
        <span className="text-xs font-mono text-faint dark:text-slate-500">
          {slug}
        </span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-100 dark:bg-cobble-900/30 text-accent dark:text-cobble-300">
          {role}
        </span>
        <div className="flex-1" />
        <span className="text-xs text-muted dark:text-slate-400">
          welcome back, {userName.split(" ")[0]}
        </span>
      </div>
    </header>
  );
}

// ────────────────────────── module tiles ────────────────────────────

// The "at a glance" grid is registry-driven: every widget registered through
// platform-web's `registerDashboardWidget` whose owning module is ENABLED in
// this workspace gets mounted. The Dashboard knows nothing about any specific
// module — the host's built-ins (web/src/dashboard/builtinWidgets) and any
// bundle/third-party module contribute through the same seam.
//
// Order + visibility are a per-workspace saved layout (orgs.dashboard_layout):
// an ordered list of widget ids with a hidden flag. Owners/admins arrange it
// in place via "Arrange". A widget the layout doesn't mention (a freshly
// enabled module, or a new bundle widget) appears at the END, visible — so the
// dashboard never silently drops a new tile.

const widgetId = (w: DashboardWidgetSpec): string => w.id ?? w.module;

interface Arranged {
  spec: DashboardWidgetSpec;
  hidden: boolean;
}

/** Merge the registry widgets (already gated to enabled modules) with the saved
 *  layout: known ids in saved order (carrying their hidden flag), then any
 *  unsaved ids appended visible. */
function arrange(widgets: DashboardWidgetSpec[], layout: DashboardLayout | undefined): Arranged[] {
  const saved = new Map((layout?.widgets ?? []).map((w, i) => [w.id, { i, hidden: w.hidden }]));
  const known = widgets
    .filter((w) => saved.has(widgetId(w)))
    .sort((a, b) => saved.get(widgetId(a))!.i - saved.get(widgetId(b))!.i)
    .map<Arranged>((spec) => ({ spec, hidden: saved.get(widgetId(spec))!.hidden }));
  const fresh = widgets
    .filter((w) => !saved.has(widgetId(w)))
    .map<Arranged>((spec) => ({ spec, hidden: false }));
  return [...known, ...fresh];
}

function ModuleTiles({
  slug,
  enabled,
  role,
}: {
  slug: string;
  enabled: Set<string>;
  role: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const widgets = useDashboardWidgets().filter((w) => enabled.has(w.module));
  const layoutQ = useQuery({
    queryKey: ["dash-layout", slug],
    queryFn: () => api.getDashboardLayout(slug),
    staleTime: 30_000,
    enabled: !!slug,
  });
  const arranged = arrange(widgets, layoutQ.data?.layout);

  // Edit state: a local draft (the arranged list) only while arranging.
  const [draft, setDraft] = useState<Arranged[] | null>(null);
  const editing = draft !== null;
  const canArrange = role === "owner" || role === "admin";

  const save = useMutation({
    mutationFn: (next: Arranged[]) => {
      // Preserve saved entries for widgets not currently registered (a
      // temporarily-disabled module) so arranging doesn't forget them.
      const liveIds = new Set(next.map((a) => widgetId(a.spec)));
      const extras = (layoutQ.data?.layout.widgets ?? []).filter((w) => !liveIds.has(w.id));
      return api.setDashboardLayout(slug, {
        widgets: [
          ...next.map((a) => ({ id: widgetId(a.spec), hidden: a.hidden })),
          ...extras,
        ],
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dash-layout", slug] });
      setDraft(null);
      toast.success("Dashboard layout saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (widgets.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-muted dark:text-slate-400">
        No user-facing modules enabled yet. Visit{" "}
        <Link to="/configuration" className="text-accent hover:underline">
          /configuration
        </Link>{" "}
        to add some.
      </section>
    );
  }

  const list = editing ? draft! : arranged;
  const visible = list.filter((a) => !a.hidden);

  const move = (i: number, dir: -1 | 1) => {
    setDraft((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };
  const toggleHidden = (i: number) =>
    setDraft((d) => (d ? d.map((a, k) => (k === i ? { ...a, hidden: !a.hidden } : a)) : d));

  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <SectionTitle className="mb-0">at a glance</SectionTitle>
        <div className="flex-1" />
        {canArrange && !editing && (
          <button
            onClick={() => setDraft(arranged)}
            className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-accent transition"
            title="Reorder and show/hide tiles"
          >
            <Sliders size={13} /> arrange
          </button>
        )}
        {editing && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDraft(null)}
              disabled={save.isPending}
              className="text-[11px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-content transition"
            >
              cancel
            </button>
            <button
              onClick={() => save.mutate(draft!)}
              disabled={save.isPending}
              className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-[11px] font-mono uppercase tracking-widest transition disabled:opacity-50"
            >
              {save.isPending ? "saving…" : "done"}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {draft!.map((a, i) => {
              const Widget = a.spec.component;
              return (
                <div
                  key={widgetId(a.spec)}
                  className={"relative rounded-xl " + (a.hidden ? "opacity-40" : "")}
                >
                  {/* the tile itself — non-interactive while arranging */}
                  <div className="pointer-events-none">
                    <Widget slug={slug} />
                  </div>
                  {/* control overlay */}
                  <div className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md bg-surface/90 dark:bg-slate-900/90 backdrop-blur border border-line dark:border-slate-700 px-1 py-0.5">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 disabled:opacity-30 transition"
                      title="Move earlier"
                    >
                      <ArrowLeft size={13} />
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === draft!.length - 1}
                      className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 disabled:opacity-30 transition"
                      title="Move later"
                    >
                      <ArrowRight size={13} />
                    </button>
                    <button
                      onClick={() => toggleHidden(i)}
                      className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition"
                      title={a.hidden ? "Show on dashboard" : "Hide from dashboard"}
                    >
                      {a.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-faint dark:text-slate-500 mt-2">
            Arrows reorder · the eye hides a tile. This arrangement is shared by everyone in the workspace.
          </p>
        </>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted dark:text-slate-400 italic">
          All tiles are hidden.{" "}
          {canArrange && (
            <button onClick={() => setDraft(arranged)} className="text-accent hover:underline not-italic">
              Arrange
            </button>
          )}{" "}
          to show some.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {visible.map((a) => {
            const Widget = a.spec.component;
            return <Widget key={widgetId(a.spec)} slug={slug} />;
          })}
        </div>
      )}
    </section>
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
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex items-baseline gap-2 mb-2">
        <LayoutList size={13} className="text-accent" />
        <Link
          to="/views"
          className="font-medium text-content dark:text-mortar-100 hover:text-accent"
        >
          {view.name}
        </Link>
        <span className="text-[10px] font-mono uppercase tracking-wider text-faint">
          {view.view_type}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-faint">
          {data.data?.items.length ?? 0} rows
        </span>
      </div>
      {data.isLoading && (
        <div className="text-xs text-faint">loading…</div>
      )}
      {!data.isLoading && items.length === 0 && (
        <div className="text-xs text-faint italic">no matching rows</div>
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
                <div className="truncate text-content dark:text-mortar-100">
                  {r.title}
                </div>
                {r.subtitle && (
                  <div className="text-xs text-muted truncate">
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
    queryFn: () => api.orgActivity(slug, 50),
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const groups = groupActivity(items);
  return (
    <section>
      <SectionTitle>recent activity</SectionTitle>
      {q.isLoading && <div className="text-xs text-faint">loading…</div>}
      {!q.isLoading && items.length === 0 && (
        <div className="text-xs text-faint italic">no activity yet</div>
      )}
      {groups.length > 0 && (
        <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800">
          {groups.map((g) => {
            const first = g.items[0];
            if (!first) return null;
            return g.items.length === 1 ? (
              <ActivityRow key={first.id} entry={first} />
            ) : (
              <ActivityGroupRow key={first.id} group={g} />
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface ActivityGroup {
  signature: string;
  items: ActivityEntry[];
}

/** Roll up consecutive entries that share actor + action + entity_type.
 *  An 8-pairings burst from a single seed run becomes one line that
 *  expands on click. Non-adjacent identical entries STAY separate —
 *  if something else happened in between, the burst was already
 *  interrupted and rolling those up would distort the timeline. */
function groupActivity(items: ActivityEntry[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const e of items) {
    const sig = `${e.actor?.display_name ?? ""}|${e.action}|${e.entity_type ?? ""}`;
    const last = out[out.length - 1];
    if (last && last.signature === sig) {
      last.items.push(e);
    } else {
      out.push({ signature: sig, items: [e] });
    }
  }
  return out;
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
      <span className="text-muted dark:text-slate-400 shrink-0">
        {actor}
      </span>
      <span className="text-content dark:text-mortar-200 shrink-0">
        {action}
      </span>
      <span className="text-content dark:text-mortar-100 truncate">
        {title ?? <span className="font-mono text-xs text-faint">{e.entity_type}</span>}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-faint shrink-0">
        {relativeTime(e.occurred_at)}
      </span>
    </li>
  );
}

/** Consolidated row for a burst of N identical-signature entries.
 *  Shows one summary line + a `×N` chip. If any entry in the group
 *  has unique detail in its diff (a name/title/label), expanding the
 *  group reveals each line; otherwise no accordion (nothing extra to
 *  show). */
function ActivityGroupRow({ group }: { group: ActivityGroup }) {
  // Guaranteed non-empty: ActivityGroup is only constructed inside
  // groupActivity which always pushes at least one item before the
  // group is recorded; and the caller only renders this for groups
  // with length > 1.
  const first = group.items[0]!;
  const last = group.items[group.items.length - 1]!;
  const action = humanAction(first.action);
  const actor = first.actor?.display_name ?? "someone";
  const titles = group.items
    .map((e) => pickString((e.diff ?? {}) as Record<string, unknown>, ["name", "title", "label"]))
    .filter((t): t is string => !!t);
  const hasUniqueDetail = titles.length > 0;
  const rowContent = (
    <div className="flex items-baseline gap-3 text-sm w-full">
      <span className="text-muted dark:text-slate-400 shrink-0">
        {actor}
      </span>
      <span className="text-content dark:text-mortar-200 shrink-0">
        {action}
      </span>
      <span className="text-content dark:text-mortar-100 truncate">
        <span className="font-mono text-xs text-faint">{first.entity_type}</span>
        <span className="ml-1.5 inline-flex items-center text-[10px] font-mono uppercase tracking-widest text-accent dark:text-cobble-400 bg-cobble-50 dark:bg-cobble-900/40 rounded px-1.5 py-0.5">
          ×{group.items.length}
        </span>
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-faint shrink-0">
        {relativeTime(last.occurred_at)}
        <span className="text-faint dark:text-slate-600"> → </span>
        {relativeTime(first.occurred_at)}
      </span>
    </div>
  );
  if (!hasUniqueDetail) {
    return <li className="px-4 py-2">{rowContent}</li>;
  }
  return (
    <li>
      <details className="group">
        <summary className="list-none cursor-pointer px-4 py-2 hover:bg-subtle dark:hover:bg-slate-800/40 transition flex items-baseline gap-2">
          <span className="text-faint dark:text-slate-600 text-[10px] shrink-0 group-open:rotate-90 transition-transform">▸</span>
          {rowContent}
        </summary>
        <ul className="border-t border-line dark:border-slate-800 bg-mortar-25 dark:bg-slate-800/20 divide-y divide-line dark:divide-slate-800/40">
          {group.items.map((e) => (
            <ActivityRow key={e.id} entry={e} />
          ))}
        </ul>
      </details>
    </li>
  );
}

// ──────────────────────── tiny helpers ──────────────────────────────

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={"text-[10px] font-mono uppercase tracking-widest text-accent " + (className ?? "mb-2")}>
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
