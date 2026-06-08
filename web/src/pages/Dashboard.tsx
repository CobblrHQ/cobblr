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

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpCircle, Compass, Eye, EyeOff, GripVertical, LayoutList, Maximize2, Minimize2, Plus, Sliders, Sparkles, X } from "lucide-react";
import { useBundleUpdates } from "../lib/useBundleUpdates";
import { useSetupCards, dismissSetup } from "../lib/setupCards";
import { EntityThumb,
  EntityTile,
  ViewModeToggle,
  useViewMode, usePageTitle, useToast,
  useDashboardWidgets, type DashboardWidgetSpec } from "@cobblr/platform-web";
// Side-effect: registers the host's built-in "at a glance" widgets (machines /
// assets / purchases) through the public registerDashboardWidget seam. The
// TileGrid renders whatever's registered for an enabled module — no per-module
// knowledge here. (inventory / labels / projects register from their own /ui.)
import "../dashboard/builtinWidgets";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { FirstRunWizard } from "../components/FirstRunWizard";
import { displaySlug } from "../lib/workspaceSlug";
import {
  api,
  getToken,
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

      <BundleUpdatesBanner slug={activeSlug} />
      <SetupCardsPanel slug={activeSlug} />

      <GettingStartedPanel
        slug={activeSlug}
        enabled={enabled}
        modules={modulesQ.data?.items ?? []}
      />

      {/* The arrangeable body — at-a-glance tiles + pinned views + recent
          activity, reorderable/hideable per workspace via one Arrange mode. */}
      <ArrangeableBody slug={activeSlug} enabled={enabled} role={activeOrg.role} />
    </div>
  );
}

// Update nudge — surfaces installed-bundle updates on the dashboard so the user
// doesn't have to hunt the marketplace (the author's #2). Auto-clears once everything's
// up to date; the "Review" button drops them on the marketplace where the
// per-bundle "Update" button lives.
function BundleUpdatesBanner({ slug }: { slug: string }) {
  const updates = useBundleUpdates(slug);
  const navigate = useNavigate();
  if (updates.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-center gap-3">
      <ArrowUpCircle size={20} className="text-amber-600 dark:text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-content dark:text-mortar-100">
          {updates.length} bundle update{updates.length === 1 ? "" : "s"} available
        </div>
        <div className="text-sm text-muted dark:text-slate-400 truncate">
          {updates.map((u) => `${u.glyph} ${u.name} v${u.installedV} → v${u.latestV}`).join(" · ")}
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate("/bundles")}
        className="shrink-0 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium px-3 py-1.5 transition"
      >
        Review
      </button>
    </div>
  );
}

// Persisted "where to start" cards from recent bundle installs (the author's #3 — the
// post-install guide that vanished). Each is dismissible once you're oriented.
function SetupCardsPanel({ slug }: { slug: string }) {
  const cards = useSetupCards(slug);
  const navigate = useNavigate();
  if (cards.length === 0) return null;
  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <div
          key={card.externalId}
          className="rounded-xl border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 p-4"
        >
          <div className="flex items-center gap-2 mb-3">
            <Compass size={16} className="text-accent shrink-0" />
            <span className="text-base shrink-0">{card.glyph}</span>
            <div className="font-medium text-content dark:text-mortar-100 min-w-0 truncate">
              Set up {card.name} — where to start
            </div>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => dismissSetup(slug, card.externalId)}
              className="text-faint hover:text-content dark:hover:text-mortar-100 p-1 shrink-0"
              title="Dismiss"
              aria-label={`Dismiss ${card.name} setup`}
            >
              <X size={15} />
            </button>
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {card.nextSteps.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => navigate(s.path ?? `/${s.module}`)}
                className="text-left rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex items-center gap-2 hover:border-cobble-400 dark:hover:border-cobble-600 transition group"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-content dark:text-mortar-100">{s.label}</div>
                  {s.hint && <div className="text-xs text-faint dark:text-slate-400 mt-0.5">{s.hint}</div>}
                </div>
                <ArrowRight size={15} className="text-faint group-hover:text-accent transition shrink-0" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Suggestion = a user-facing module a brand-new workspace can be nudged to
// turn on. Derived data-drivenly from the workspace's module catalog (no
// hardcoded list): the `stock` band is Cobblr's shipped first-party domains
// (assets / inventory / projects / …), which excludes `core-*` plumbing,
// marketplace connectors, and `user`-band samples — exactly the set that
// would earn a nav entry. Copy comes from each module's own displayName +
// description, so new modules appear automatically and never drift.
type Suggestion = { name: string; to: string; label: string; description: string };
// Plain-language, outcome-first card copy for the common domains — module
// `description`s are written for builders ("polymorphic allocations") and read
// poorly on a first-run card. Anything not in this map falls back to the
// module's own description, so new/3rd-party modules still appear automatically.
const SUGGESTION_COPY: Record<string, string> = {
  inventory: "Track parts & supplies you keep on hand — quantities, locations, low-stock alerts.",
  assets: "Track things you own and look after — tools, gear, plants, collectibles.",
  machines: "Catalog your machines — printers, tools, equipment — with photos and state.",
  projects: "Plan projects & tasks, including ones that wait on parts or other work.",
  lists: "Keep simple checklists — shopping, packing, to-dos.",
  tracking: "Log a number over time toward a goal and watch the trend.",
  purchases: "Record orders and what they cost, and roll the spend up.",
  labels: "Print QR / labels for anything in your workspace.",
  digifab: "Send design files to the software that runs your machine.",
};
// Card blurbs read better as one line — take the module description's first
// sentence (full descriptions can be a paragraph of detail).
function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

// Empty-state onboarding. Shows when the active workspace has no
// entities across any of the user-facing modules — the dashboard
// would otherwise show a row of "0" tiles with no clear next step.
// Hides itself the moment any module gets its first entity.
function GettingStartedPanel({
  slug,
  enabled,
  modules,
}: {
  slug: string;
  enabled: Set<string>;
  modules: OrgModuleListItem[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  // First-run wizard is the default empty-state. "Skip for now" remembers the
  // dismissal per-workspace (device-local) and falls back to the plain
  // action-card panel. The empty-state self-heals once any entity exists, so
  // this flag only matters for a skipped-but-still-empty workspace.
  const dismissKey = `cobblr.firstRun.dismissed.${slug}`;
  const [skippedWizard, setSkippedWizard] = useState(() => {
    try {
      return localStorage.getItem(dismissKey) === "1";
    } catch {
      return false;
    }
  });
  // Turn on a not-yet-enabled module straight from a suggestion card and
  // drop the user into it — no detour through Configuration.
  const enableMut = useMutation({
    mutationFn: (s: Suggestion) => api.enableModule(slug, s.name),
    onSuccess: async (_r, s) => {
      await qc.invalidateQueries({ queryKey: ["org-modules", slug] });
      navigate(s.to);
    },
    onError: (e) =>
      toast.error(
        e instanceof Error ? e.message : "Couldn't enable that — open Configuration.",
      ),
  });

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

  // Render once we know the workspace is empty. A brand-new workspace
  // with NO modules enabled (enabled.size === 0) leaves the probe
  // disabled → data undefined; treat that as "empty" too so the panel
  // still greets a truly blank install. Hide the moment any module
  // gains its first entity.
  if (enabled.size > 0 && probe.data === undefined) return null; // still probing
  if ((probe.data ?? 0) > 0) return null; // has content already

  // The default empty-state: the bundle-rooted "what do you want to set up?"
  // wizard. The plain action-card fallback below is reached only if the user
  // taps "Skip for now".
  if (!skippedWizard) {
    return (
      <FirstRunWizard
        slug={slug}
        onSkip={() => {
          try {
            localStorage.setItem(dismissKey, "1");
          } catch {
            /* private mode / disabled storage — just skip in-memory */
          }
          setSkippedWizard(true);
        }}
      />
    );
  }

  // Determine the most relevant "first thing to do" based on which
  // user-facing modules are enabled.
  const firstActions: Array<{ to: string; label: string; description: string }> = [];
  if (enabled.has("inventory"))
    firstActions.push({
      to: "/inventory",
      label: "Add a part",
      description:
        "Countable stock you keep on hand — components, materials, consumables — with quantities and low-stock alerts. Bulk-import via CSV.",
    });
  if (enabled.has("machines"))
    firstActions.push({
      to: "/machines",
      label: "Add a machine",
      description: "Catalog your tools, printers, and equipment with photos + state.",
    });
  if (enabled.has("assets"))
    firstActions.push({
      to: "/assets",
      label: "Add an asset",
      description:
        "Something you own and look after over time — a tool, plant, or collectible — with photos, notes, and recurring care reminders.",
    });
  if (enabled.has("projects"))
    firstActions.push({
      to: "/projects",
      label: "Start a project",
      description: "Group tasks and cross-module dependencies under one heading.",
    });

  // Greyed-out "turn this on" cards for the curated domain modules that
  // are available in this workspace's catalog but not yet enabled.
  const suggestions: Suggestion[] = modules
    .filter(
      (m) => !m.enabled && m.band === "stock" && !m.name.startsWith("core-"),
    )
    .map((m) => ({
      name: m.name,
      to: `/${m.name}`,
      label: m.displayName,
      description: SUGGESTION_COPY[m.name] ?? firstSentence(m.description),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

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
          ? "Pick a first thing to add below, or install a ready-made starter pack from the marketplace."
          : "Cobblr starts empty and shows only what you switch on. Turn on a module below to get going, or install a ready-made starter pack — build exactly the workspace you need, nothing you don't."}
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
            Library, Bookshelf, and more. Comes wired up and ready to use.
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

      {/* Greyed-out suggestions — so a new user discovers what Cobblr can
          track without first digging into Configuration. One tap turns
          the module on and drops them straight into it. */}
      {suggestions.length > 0 && (
        <div className="pt-1 space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-accent">
            // or turn one on to get started
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((s) => {
              const busy =
                enableMut.isPending && enableMut.variables?.name === s.name;
              return (
                <button
                  key={s.name}
                  type="button"
                  disabled={enableMut.isPending}
                  onClick={() => enableMut.mutate(s)}
                  className="text-left rounded-lg border border-dashed border-line dark:border-slate-700 bg-surface/40 dark:bg-slate-900/40 p-3 opacity-70 hover:opacity-100 hover:border-accent disabled:cursor-wait transition"
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium text-content dark:text-mortar-100">
                    <Plus size={13} className="text-accent shrink-0" />
                    {busy ? "Enabling…" : `Enable ${s.label}`}
                  </div>
                  <div className="text-xs text-muted dark:text-slate-400 mt-0.5">
                    {s.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
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
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title tracking-tight">
          {orgName}
        </h1>
        <span className="text-xs font-mono text-faint dark:text-slate-500">
          {displaySlug(slug)}
        </span>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-100 dark:bg-cobble-900/30 text-accent dark:text-cobble-300">
          {role}
        </span>
        <div className="flex-1" />
        {/* Always-available "grow your workspace" path — the empty-state Enable
            cards vanish once you have data, so this is how you keep adding
            modules / starter packs without hunting in the account menu. */}
        <Link
          to="/configuration"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-content dark:hover:text-mortar-100 transition shrink-0"
          title="Turn on modules, install a starter pack, customize this workspace"
        >
          <Sliders size={13} /> Set up workspace
        </Link>
      </div>
      <div className="text-xs text-muted dark:text-slate-400 mt-2">
        welcome back, {userName.split(" ")[0]}
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

interface WidgetDraft {
  spec: DashboardWidgetSpec;
  hidden: boolean;
  span: number; // grid columns the tile occupies: 1 (normal) or 2 (wide)
}

/** Merge the registry widgets (already gated to enabled modules) with the saved
 *  layout: known ids in saved order (carrying hidden + span), then any unsaved
 *  ids appended visible at span 1 — so a freshly enabled module's tile is never
 *  silently dropped. */
function arrangeWidgets(
  widgets: DashboardWidgetSpec[],
  layout: DashboardLayout | undefined,
): WidgetDraft[] {
  const saved = new Map(
    (layout?.widgets ?? []).map((w, i) => [w.id, { i, hidden: w.hidden, span: w.span === 2 ? 2 : 1 }]),
  );
  const known = widgets
    .filter((w) => saved.has(widgetId(w)))
    .sort((a, b) => saved.get(widgetId(a))!.i - saved.get(widgetId(b))!.i)
    .map<WidgetDraft>((spec) => {
      const s = saved.get(widgetId(spec))!;
      return { spec, hidden: s.hidden, span: s.span };
    });
  const fresh = widgets
    .filter((w) => !saved.has(widgetId(w)))
    .map<WidgetDraft>((spec) => ({ spec, hidden: false, span: 1 }));
  return [...known, ...fresh];
}

// The dashboard's arrangeable sections, in default order.
const SECTION_IDS = ["at_a_glance", "pinned_views", "recent_activity"] as const;
type SectionId = (typeof SECTION_IDS)[number];
const SECTION_TITLE: Record<SectionId, string> = {
  at_a_glance: "at a glance",
  pinned_views: "your views",
  recent_activity: "recent activity",
};

interface SectionDraft {
  id: SectionId;
  hidden: boolean;
}

/** Known section ids in saved order (carrying hidden), then any not-yet-saved
 *  ones appended visible. */
function arrangeSections(layout: DashboardLayout | undefined): SectionDraft[] {
  const saved = new Map((layout?.sections ?? []).map((s, i) => [s.id, { i, hidden: s.hidden }]));
  const known = SECTION_IDS.filter((id) => saved.has(id))
    .sort((a, b) => saved.get(a)!.i - saved.get(b)!.i)
    .map<SectionDraft>((id) => ({ id, hidden: saved.get(id)!.hidden }));
  const fresh = SECTION_IDS.filter((id) => !saved.has(id)).map<SectionDraft>((id) => ({ id, hidden: false }));
  return [...known, ...fresh];
}

/** Move arr[from] to index `to`, returning a new array (no-op on bad indices). */
function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// One Arrange mode for the whole body: reorder/hide the SECTIONS (at a glance /
// your views / recent activity) AND, inside "at a glance", reorder/hide/resize
// the tiles. Drag or use the buttons. Persisted per workspace; owner/admin only.
function ArrangeableBody({
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
  const layout = layoutQ.data?.layout;
  const baseWidgets = arrangeWidgets(widgets, layout);
  const baseSections = arrangeSections(layout);
  const canArrange = role === "owner" || role === "admin";

  const [draft, setDraft] = useState<{ widgets: WidgetDraft[]; sections: SectionDraft[] } | null>(null);
  const editing = draft !== null;
  const [dragSection, setDragSection] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      // Preserve saved entries for widgets not currently registered (a
      // temporarily-disabled module) so arranging doesn't forget them.
      const liveIds = new Set(d.widgets.map((w) => widgetId(w.spec)));
      const extras = (layout?.widgets ?? []).filter((w) => !liveIds.has(w.id));
      return api.setDashboardLayout(slug, {
        widgets: [
          ...d.widgets.map((w) => ({ id: widgetId(w.spec), hidden: w.hidden, span: w.span })),
          ...extras,
        ],
        sections: d.sections.map((s) => ({ id: s.id, hidden: s.hidden })),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dash-layout", slug] });
      setDraft(null);
      toast.success("Dashboard layout saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const startArrange = () => setDraft({ widgets: baseWidgets, sections: baseSections });
  const setWidgets = (fn: (w: WidgetDraft[]) => WidgetDraft[]) =>
    setDraft((d) => (d ? { ...d, widgets: fn(d.widgets) } : d));
  const setSections = (fn: (s: SectionDraft[]) => SectionDraft[]) =>
    setDraft((d) => (d ? { ...d, sections: fn(d.sections) } : d));

  const sections = editing ? draft!.sections : baseSections;
  const wlist = editing ? draft!.widgets : baseWidgets;
  const shown = editing ? sections : sections.filter((s) => !s.hidden);

  const renderContent = (id: SectionId) => {
    if (id === "at_a_glance")
      return (
        <TileGrid
          slug={slug}
          widgets={wlist}
          editing={editing}
          hasModules={widgets.length > 0}
          onMove={(i, dir) => setWidgets((w) => reorder(w, i, i + dir))}
          onReorder={(from, to) => setWidgets((w) => reorder(w, from, to))}
          onToggleHidden={(i) =>
            setWidgets((w) => w.map((a, k) => (k === i ? { ...a, hidden: !a.hidden } : a)))
          }
          onResize={(i) =>
            setWidgets((w) => w.map((a, k) => (k === i ? { ...a, span: a.span === 2 ? 1 : 2 } : a)))
          }
        />
      );
    if (id === "pinned_views") return <PinnedViews slug={slug} editing={editing} />;
    return <RecentActivity slug={slug} editing={editing} />;
  };

  return (
    <div className="space-y-6">
      {canArrange && (
        <div className="flex items-center justify-end gap-2 -mb-3">
          {!editing ? (
            <button
              onClick={startArrange}
              className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-accent transition"
              title="Reorder, hide, and resize the dashboard"
            >
              <Sliders size={13} /> arrange dashboard
            </button>
          ) : (
            <>
              <button
                onClick={() => setDraft(null)}
                disabled={save.isPending}
                className="text-[11px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 hover:text-content transition"
              >
                cancel
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-[11px] font-mono uppercase tracking-widest transition disabled:opacity-50"
              >
                {save.isPending ? "saving…" : "done"}
              </button>
            </>
          )}
        </div>
      )}

      {shown.map((s) => {
        const idx = sections.findIndex((x) => x.id === s.id);
        const content = renderContent(s.id);
        // Fragment (not a wrapper div) so a section that renders null — e.g.
        // empty pinned views — leaves no stray gap in the space-y stack.
        if (!editing) return <Fragment key={s.id}>{content}</Fragment>;
        return (
          <section
            key={s.id}
            draggable
            onDragStart={() => setDragSection(idx)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragSection !== null) setSections((arr) => reorder(arr, dragSection, idx));
              setDragSection(null);
            }}
            className={
              "rounded-xl border border-dashed border-line dark:border-slate-700 p-3 " +
              (s.hidden ? "opacity-50" : "")
            }
          >
            <div className="flex items-center gap-2 mb-2">
              <GripVertical size={14} className="text-faint dark:text-slate-600 cursor-grab" />
              <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
                {SECTION_TITLE[s.id]}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setSections((arr) => reorder(arr, idx, idx - 1))}
                disabled={idx === 0}
                className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 disabled:opacity-30 transition"
                title="Move up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                onClick={() => setSections((arr) => reorder(arr, idx, idx + 1))}
                disabled={idx === sections.length - 1}
                className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 disabled:opacity-30 transition"
                title="Move down"
              >
                <ArrowDown size={14} />
              </button>
              <button
                onClick={() =>
                  setSections((arr) => arr.map((x, k) => (k === idx ? { ...x, hidden: !x.hidden } : x)))
                }
                className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition"
                title={s.hidden ? "Show section" : "Hide section"}
              >
                {s.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {content}
          </section>
        );
      })}

      {editing && (
        <p className="text-[11px] text-faint dark:text-slate-500">
          Drag a section (or use ↑↓) to reorder; the eye hides it. Inside “at a glance”, drag tiles or use the controls to reorder, resize, and hide. Shared by everyone in the workspace.
        </p>
      )}
    </div>
  );
}

// The "at a glance" tile grid. Pure renderer driven by the arranged widgets:
// in normal mode it draws the visible tiles (honouring each tile's `span`); in
// edit mode every tile is draggable and carries reorder / resize / hide
// controls. The section header + Arrange entry live in ArrangeableBody.
function TileGrid({
  slug,
  widgets,
  editing,
  hasModules,
  onMove,
  onReorder,
  onToggleHidden,
  onResize,
}: {
  slug: string;
  widgets: WidgetDraft[];
  editing: boolean;
  hasModules: boolean;
  onMove: (i: number, dir: -1 | 1) => void;
  onReorder: (from: number, to: number) => void;
  onToggleHidden: (i: number) => void;
  onResize: (i: number) => void;
}) {
  const [dragTile, setDragTile] = useState<number | null>(null);
  const spanCls = (span: number) => (span === 2 ? "col-span-2" : "");

  if (!hasModules) {
    // The GettingStartedPanel above already owns the empty-workspace message
    // (with the "Enable X" cards). A second "no modules — visit /configuration"
    // tile here is just redundant noise, so render nothing.
    return null;
  }

  if (!editing) {
    const visible = widgets.filter((w) => !w.hidden);
    return (
      <section>
        <SectionTitle>at a glance</SectionTitle>
        {visible.length === 0 ? (
          <p className="text-sm text-muted dark:text-slate-400 italic">
            All tiles are hidden — use Arrange to show some.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {visible.map((a) => {
              const Widget = a.spec.component;
              return (
                <div key={widgetId(a.spec)} className={spanCls(a.span)}>
                  <Widget slug={slug} getToken={getToken} />
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {widgets.map((a, i) => {
        const Widget = a.spec.component;
        return (
          <div
            key={widgetId(a.spec)}
            draggable
            onDragStart={() => setDragTile(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragTile !== null) onReorder(dragTile, i);
              setDragTile(null);
            }}
            className={"relative rounded-xl cursor-grab " + spanCls(a.span) + (a.hidden ? " opacity-40" : "")}
          >
            <div className="pointer-events-none">
              <Widget slug={slug} getToken={getToken} />
            </div>
            <div className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md bg-surface/90 dark:bg-slate-900/90 backdrop-blur border border-line dark:border-slate-700 px-1 py-0.5">
              <button
                onClick={() => onMove(i, -1)}
                disabled={i === 0}
                className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 disabled:opacity-30 transition"
                title="Move earlier"
              >
                <ArrowLeft size={13} />
              </button>
              <button
                onClick={() => onMove(i, 1)}
                disabled={i === widgets.length - 1}
                className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 disabled:opacity-30 transition"
                title="Move later"
              >
                <ArrowRight size={13} />
              </button>
              <button
                onClick={() => onResize(i)}
                className="p-0.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition"
                title={a.span === 2 ? "Shrink to 1 column" : "Widen to 2 columns"}
              >
                {a.span === 2 ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                onClick={() => onToggleHidden(i)}
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
  );
}

// ──────────────────────── pinned saved views ────────────────────────

function PinnedViews({ slug, editing = false }: { slug: string; editing?: boolean }) {
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
  // When arranging, the section bar (ArrangeableBody) supplies the title, and
  // an empty section must still show SOMETHING so it stays reorderable.
  if (pinned.length === 0)
    return editing ? (
      <p className="text-xs text-faint dark:text-slate-500 italic">No pinned views yet.</p>
    ) : null;
  return (
    <section>
      {!editing && (
      <div className="flex items-center gap-2 mb-2">
        <SectionTitle>your views</SectionTitle>
        <div className="flex-1" />
        <ViewModeToggle mode={mode} onChange={setMode} />
      </div>
      )}
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

// Provisioning/plumbing entity-types that mean nothing to a user ("tenant
// provisioned", "module enabled ×23", "joined user", workspace created). Hidden
// from the dashboard summary so a fresh workspace doesn't lead with an audit
// log of things it did to itself. The full /activity page still shows everything.
const ACTIVITY_NOISE = new Set(["org_module", "org", "user", "tenant"]);

function RecentActivity({ slug, editing = false }: { slug: string; editing?: boolean }) {
  const q = useQuery({
    queryKey: ["dash-activity", slug],
    queryFn: () => api.orgActivity(slug, 50),
    staleTime: 30_000,
  });
  const items = (q.data?.items ?? []).filter(
    (e) => !ACTIVITY_NOISE.has(e.entity_type ?? ""),
  );
  const groups = groupActivity(items);
  return (
    <section>
      {!editing && <SectionTitle>recent activity</SectionTitle>}
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
