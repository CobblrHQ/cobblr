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

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpCircle, CheckCircle2, ChevronDown, Compass, Download, Eye, EyeOff, GripVertical, LayoutList, Maximize2, Minimize2, Pin, Plus, Sliders, Sparkles, X } from "lucide-react";
import { useBundleUpdates, type BundleUpdate } from "../lib/useBundleUpdates";
import { classifyBundleUpdate, tierAutoApplies, updateMayTeardownCatalogs } from "../lib/bundleUpdateTier";
import { useDetailRoute } from "../lib/useDetailRoute";
import { useSetupCards, dismissSetup } from "../lib/setupCards";
import { EntityThumb,
  usePageTitle, useToast, useImageSrc,
  useDashboardWidgets, TileCollapseContext, type DashboardWidgetSpec } from "@cobblr/platform-web";
// Side-effect: registers the host's built-in "at a glance" widgets (machines /
// assets / purchases) through the public registerDashboardWidget seam. The
// TileGrid renders whatever's registered for an enabled module — no per-module
// knowledge here. (inventory / labels / projects register from their own /ui.)
import "../dashboard/builtinWidgets";
import { expandInstanceWidgets } from "../dashboard/expandInstanceWidgets";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { WhatToDoPanel } from "../components/WhatToDoPanel";
import { PendingAiShareCallout } from "../components/PendingAiShareCallout";
import { useNavModules, INSTANCE_PREFIX } from "../components/useNavModules";
import { HeatmapRenderer } from "./ViewsPage";
import { liveNextStepLabel } from "../lib/featured-bundles";
import {
  api,
  getToken,
  ApiError,
  isFocused,
  type ActivityEntry,
  type DashboardLayout,
  type OrgModuleListItem,
  type QuickstartSuggestion,
  type SavedView,
} from "../lib/api";

/** Homepage quick-links: big tap targets for the destinations this workspace
 *  actually uses (Scan Inbox, each instance like "Yarn", the domain modules),
 *  driven by the SAME nav source as the sidebar/hamburger so labels + order
 *  stay consistent. Mobile-first — on a phone the nav is otherwise hidden
 *  behind the hamburger, which users don't discover. Renders nothing until the
 *  nav is known. */
function QuickLinks({ slug }: { slug: string }) {
  const nav = useNavModules(slug);
  const dests = nav.tops
    .filter(
      (m) =>
        !(m as { hidden?: boolean }).hidden &&
        !m.name.startsWith("__heading__") &&
        !m.name.startsWith("__group__") &&
        // Entries folded into "more ▾" (by default: lists/projects/purchases)
        // don't take Jump-to tiles either — the 8 slots go to the workhorses.
        !nav.overflowNames.has(m.name),
    )
    .slice(0, 8)
    .map((m) => ({
      key: m.name,
      label: m.displayName,
      to: m.name.startsWith(INSTANCE_PREFIX) ? `/${m.name.slice(INSTANCE_PREFIX.length)}` : `/${m.name}`,
    }));
  if (dests.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-2">
        Jump to
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {dests.map((d) => (
          <Link
            key={d.key}
            to={d.to}
            className="flex items-center justify-between gap-2 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-3 text-sm font-medium text-content dark:text-mortar-100 hover:border-accent active:scale-[0.99] transition"
          >
            <span className="truncate">{d.label}</span>
            <ArrowRight size={16} className="text-faint dark:text-slate-500 shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}

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

      {/* Owner action: a member offered to share their AI and it's waiting on
          approval (until then the workspace has no AI). Loud + inline-actionable
          so it isn't a dead-end. Renders nothing unless there's a pending offer. */}
      <PendingAiShareCallout slug={activeSlug} role={activeOrg.role} />

      {/* The cockpit (redesign B2): what needs me TODAY, derived from the
          trackers' own field semantics. Renders nothing when nothing needs you. */}
      <AttentionFeed slug={activeSlug} />

      {/* The two scanner CTAs share a row so they cost ONE band of vertical space,
          not two (the author, 2026-07-26). flex-1 means whichever one is present alone
          still spans full width; `empty:hidden` drops the row entirely when both
          self-hide, so it never leaves a dead gap.
          - PutAwayCard: scanned-but-homeless items (put-away.md §5) — the founding
            mess; renders nothing when everything has a home.
          - BundleSuggestionsCard: captures that fit an uninstalled bundle (a pile
            of VIN scans → Vehicles); renders nothing when there's nothing to suggest. */}
      <div className="flex flex-col md:flex-row gap-3 md:items-stretch empty:hidden">
        <PutAwayCard slug={activeSlug} />
        <BundleSuggestionsCard slug={activeSlug} enabled={enabled} role={activeOrg.role} />
      </div>

      {/* Quick links to the things this workspace uses most (Scan Inbox, Yarn,
          …). High up + big tap targets so a phone user isn't forced to find the
          hamburger to reach her instance or the scan inbox. */}
      <QuickLinks slug={activeSlug} />

      <SetupCardsPanel slug={activeSlug} />

      <GettingStartedPanel
        slug={activeSlug}
        enabled={enabled}
        modules={modulesQ.data?.items ?? []}
      />

      {/* The arrangeable body — at-a-glance tiles + pinned views + the scanner
          capture queue ("what to do" + waiting-to-file) + recent activity, all
          reorderable/hideable per workspace via one Arrange mode. The capture
          queue used to render BELOW here as a demoted "add more" bar; it's now
          the `scan_inbox` section, above recent activity (the author, 2026-07-10). */}
      <ArrangeableBody
        slug={activeSlug}
        enabled={enabled}
        role={activeOrg.role}
        modules={modulesQ.data?.items ?? []}
      />
    </div>
  );
}

/** The put-away front door: "N scanned items don't have a home yet →
 *  Put them away." ONE verb, keyed to the situation (a captured backlog =
 *  Guided Organize's native case): it opens the plan, which is a PREVIEW —
 *  nothing files until groups are accepted, so there is no wrong click.
 *  Live Sort deliberately does NOT appear here; it lives where scanning
 *  starts (scan page header, camera Sort chip, the empty-workspace
 *  mission). Hidden at zero. */
function PutAwayCard({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["scan-stats", slug],
    queryFn: () => api.getScanStats(slug),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const unfiled = q.data?.unfiled ?? 0;
  const ready = q.data?.ready ?? 0;
  // Warm the plan the moment the card shows a count (debounced so a scanning
  // burst settles first): the click should REVEAL a plan, not start one. The
  // server dedupes by backlog fingerprint, so repeats are free.
  useEffect(() => {
    if (unfiled === 0 && ready === 0) return;
    const t = setTimeout(() => {
      void api.organizePlan(slug, { scope: "pending", warm: true }).catch(() => {});
    }, 5_000);
    return () => clearTimeout(t);
  }, [slug, unfiled, ready]);
  if (unfiled === 0 && ready === 0) return null;
  // Acknowledge BOTH: things that still need a home AND things already set,
  // just waiting to be physically put away.
  const parts: string[] = [];
  if (unfiled > 0) parts.push(`${unfiled} scanned item${unfiled === 1 ? "" : "s"} without a home`);
  if (ready > 0) parts.push(`${ready} ready to put away`);
  return (
    // Stack until there's room for a real side-by-side. `flex-wrap` did NOT save
    // this: the copy is flex-1 + min-w-0, so it SHRANK to whatever the button
    // left rather than pushing the button to the next line — the sentence wrapped
    // in a half-width column while the button sat in space. Below sm the copy
    // gets the full width and the button goes underneath it.
    <section
      className="md:flex-1 md:min-w-0 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-4 py-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center"
      data-testid="putaway-card"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="text-xl shrink-0 leading-tight">📦</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-content dark:text-mortar-100">
            {parts.join(", and ")}.
          </div>
          <div className="text-xs text-muted dark:text-slate-400">
            Preview where everything should go - nothing moves until you confirm.
          </div>
        </div>
      </div>
      <Link
        to="/scan?view=plan"
        className="inline-flex items-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium transition shrink-0"
      >
        Put them away <ArrowRight size={14} />
      </Link>
    </section>
  );
}

/** Cheap "does this workspace have any committed content?" probe — mirrors
 *  GettingStartedPanel's, so BundleSuggestionsCard only surfaces on an
 *  ESTABLISHED workspace (a brand-new one gets the prominent first-run hero,
 *  which already offers the same install). One limit=1 read per enabled domain
 *  module + each named instance; cached. */
async function probeWorkspaceItemCount(slug: string, enabled: Set<string>): Promise<number> {
  const wrap = (path: string) =>
    api.request<{ items: unknown[] }>("GET", `/orgs/${slug}${path}`).then((r) => r.items.length).catch(() => 0);
  const probes: Array<Promise<number>> = [];
  if (enabled.has("inventory")) probes.push(wrap("/modules/inventory/parts?limit=1"));
  if (enabled.has("machines")) probes.push(wrap("/modules/machines/machines?limit=1"));
  if (enabled.has("assets")) probes.push(wrap("/modules/assets/assets?limit=1"));
  if (enabled.has("projects")) probes.push(wrap("/modules/projects/projects?limit=1"));
  if (enabled.has("purchases")) probes.push(wrap("/modules/purchases/orders?limit=1"));
  const instances = await api.listInstances(slug).then((r) => r.items).catch(() => []);
  for (const inst of instances.filter((i) => !i.is_default))
    probes.push(wrap(`/instances/${encodeURIComponent(inst.instance_name)}/items?limit=1`));
  const counts = await Promise.all(probes);
  return counts.reduce((a, b) => a + b, 0);
}

/** Established-workspace nudge: pending scan captures that fit a bundle you
 *  haven't installed ("3 look like Vehicles → install"). One tap installs the
 *  bundle AND files every fitting capture into it (the capture-first materialize
 *  path). Owner/admin only (install changes composition). Hidden on empty
 *  workspaces (the first-run hero owns that) and when there's nothing to suggest. */
function BundleSuggestionsCard({ slug, enabled, role }: { slug: string; enabled: Set<string>; role?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canInstall = role === "owner" || role === "admin";
  const contentQ = useQuery({
    queryKey: ["dash-content-probe", slug, Array.from(enabled).sort().join(",")],
    queryFn: () => probeWorkspaceItemCount(slug, enabled),
    enabled: canInstall && enabled.size > 0,
    staleTime: 60_000,
  });
  const hasContent = (contentQ.data ?? 0) > 0;
  const qs = useQuery({
    queryKey: ["quickstart", slug],
    queryFn: () => api.quickstart(slug),
    enabled: canInstall && hasContent,
    staleTime: 60_000,
  });
  const materializeMut = useMutation({
    mutationFn: (s: QuickstartSuggestion) => api.materializeQuickstart(slug, s.bundle_external_id),
    onSuccess: (r, s) => {
      toast.success(`Installed ${s.bundle_name} — filed ${r.created} ${s.noun}${r.created === 1 ? "" : "s"}.`);
      void qc.invalidateQueries({ queryKey: ["quickstart", slug] });
      void qc.invalidateQueries({ queryKey: ["org-modules", slug] });
      void qc.invalidateQueries({ queryKey: ["instances", slug] });
      void qc.invalidateQueries({ queryKey: ["scan-inbox", slug] });
      void qc.invalidateQueries({ queryKey: ["scan-stats", slug] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't install that."),
  });
  if (!canInstall || !hasContent) return null;
  const suggestions = qs.data?.suggestions ?? [];
  if (suggestions.length === 0) return null;
  return (
    <section
      className="md:flex-1 md:min-w-0 rounded-lg border border-accent/40 bg-accent/[0.06] dark:bg-accent/10 px-4 py-3 space-y-2"
      data-testid="bundle-suggestions"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-content dark:text-mortar-100">
        <Sparkles size={15} className="text-accent shrink-0" />
        You've scanned things that fit a table you don't have yet
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((s) => {
          const busy = materializeMut.isPending && materializeMut.variables?.bundle_external_id === s.bundle_external_id;
          return (
            <button
              key={s.bundle_external_id}
              type="button"
              onClick={() => materializeMut.mutate(s)}
              disabled={materializeMut.isPending}
              title={s.sample_names.length ? `e.g. ${s.sample_names.join(", ")}` : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
            >
              <Download size={14} />
              {busy
                ? `Installing ${s.bundle_name}…`
                : `${s.count} look${s.count === 1 ? "s" : ""} like ${s.bundle_name} — install`}
            </button>
          );
        })}
      </div>
      <div className="text-[10px] text-faint dark:text-slate-500">
        Installs the bundle and files those scanned items into it. Or triage them one-by-one in the Scan inbox.
      </div>
    </section>
  );
}

// "What needs me" — the dashboard's attention feed (redesign B2). Every row is
// one tap to act; severity-ordered (overdue → low stock → captures → upcoming).
function AttentionFeed({ slug }: { slug: string }) {
  const q = useQuery({
    queryKey: ["attention", slug],
    queryFn: () => api.getAttention(slug),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  // pending_scans is dropped HERE (not in the endpoint): the dashboard already
  // shows the scanned queue + col-3 typed captures right below — a third
  // "N captures waiting" line was pure double-count.
  const items = (q.data?.items ?? []).filter((i) => i.kind !== "pending_scans");
  if (items.length === 0) return null;
  const tone: Record<string, string> = {
    overdue: "border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/20",
    low_stock: "border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/20",
    pending_scans: "border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20",
    upcoming: "border-line dark:border-slate-700 bg-surface dark:bg-slate-900",
  };
  const glyph: Record<string, string> = { overdue: "⏰", low_stock: "📉", pending_scans: "📷", upcoming: "📅" };
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">// needs you</div>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <AttentionRow key={`${it.kind}-${it.route}-${i}`} slug={slug} item={it} tone={tone[it.kind] ?? tone.upcoming ?? ""} glyph={glyph[it.kind] ?? "•"} />
        ))}
      </ul>
    </section>
  );
}

type AttentionItem = Awaited<ReturnType<typeof api.getAttention>>["items"][number];

/** One attention row. The ROW expands in place to its individual items — each
 *  with an inline quick action where one exists (tasks: check off; bed-clear:
 *  Good/Scrapped verdict) — so you act where you see it (the author). The trailing
 *  arrow still jumps to the module page. */
function AttentionRow({ slug, item: it, tone, glyph }: { slug: string; item: AttentionItem; tone: string; glyph: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["attention", slug] });
  const doneTask = useMutation({
    mutationFn: (id: string) => api.request("PATCH", `/orgs/${slug}/modules/projects/tasks/${id}`, { status: "done" }),
    onSuccess: () => { toast.success("Task done."); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't complete the task"),
  });
  const verdict = useMutation({
    mutationFn: (v: { conn: string; dev: string; outcome: "good" | "scrapped" }) =>
      api.markDigifabDeviceReady(slug, v.conn, v.dev, v.outcome),
    onSuccess: (_r, v) => { toast.success(v.outcome === "good" ? "Marked good — printer freed." : "Scrapped — effects reversed."); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't record the verdict"),
  });
  const entries = it.entries ?? [];
  const expandable = entries.length > 0;
  // Few items → their ACTIONS live on the closed row itself (the author: "I have to
  // open the overdue task to check it off"). Many items → expand first.
  const inlineActs = entries.length > 0 && entries.length <= 3 && entries.some((e) => e.action);
  const taskCheck = (id: string) => (
    <button
      type="button"
      onClick={(ev) => { ev.stopPropagation(); doneTask.mutate(id); }}
      disabled={doneTask.isPending}
      title="Mark done"
      className="shrink-0 w-4 h-4 rounded border border-line dark:border-slate-500 hover:border-accent hover:bg-accent/10 transition inline-flex items-center justify-center align-[-2px] group/cb"
    >
      <CheckCircle2 size={11} className="opacity-0 group-hover/cb:opacity-100 text-accent" />
    </button>
  );
  const verdictBtns = (conn: string, dev: string) => (
    <span className="shrink-0 inline-flex items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
      <button type="button" onClick={() => verdict.mutate({ conn, dev, outcome: "good" })} disabled={verdict.isPending}
        className="rounded bg-moss-600 hover:bg-moss-700 text-white text-[11px] font-medium px-2 py-0.5 transition">Good</button>
      <button type="button" onClick={() => verdict.mutate({ conn, dev, outcome: "scrapped" })} disabled={verdict.isPending}
        className="rounded border border-ember-300 dark:border-ember-700 text-ember-600 dark:text-ember-400 text-[11px] font-medium px-2 py-0.5 hover:bg-ember-50 dark:hover:bg-ember-950/30 transition">Scrapped</button>
    </span>
  );
  return (
    <li>
      <div className={`rounded-lg border text-sm transition ${tone} ${open ? "" : "hover:border-accent"}`}>
        <div className="flex items-center gap-3 px-3 py-2 group">
          <button
            type="button"
            disabled={!expandable}
            onClick={() => setOpen((o) => !o)}
            className={"min-w-0 flex items-center gap-3 text-left disabled:cursor-default shrink-0" + (inlineActs && !open ? "" : " flex-1")}
            title={expandable ? (open ? "Collapse" : "Show the items — act on them right here") : undefined}
          >
            <span className="shrink-0">{glyph}</span>
            <span className="min-w-0 truncate text-content dark:text-mortar-100">
              <strong>{it.count}</strong> {it.label}
              {!open && !inlineActs && it.sample.length > 0 && (
                <span className="text-faint dark:text-slate-400"> — {it.sample.join(" · ")}{it.count > it.sample.length ? " …" : ""}</span>
              )}
            </span>
          </button>
          {/* Few-item rows carry their actions ON the closed row — as SIBLINGS
              of the expand button (a nested <button> is invalid HTML and eats
              clicks). */}
          {!open && inlineActs && (
            <span className="flex-1 min-w-0 truncate text-[13px] text-faint dark:text-slate-400 flex items-center gap-2">
              {entries.map((e, i) => (
                <span key={e.id} className="whitespace-nowrap inline-flex items-center gap-1.5">
                  {i > 0 && <span className="text-faint/60">·</span>}
                  {e.action?.task && taskCheck(e.action.task)}
                  <span className="truncate">{e.title}</span>
                  {e.action?.connection_id && e.action?.device_id && verdictBtns(e.action.connection_id, e.action.device_id)}
                </span>
              ))}
            </span>
          )}
          {expandable && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="shrink-0"
              aria-label={open ? "Collapse" : "Expand"}
            >
              <ChevronDown size={13} className={"text-faint transition-transform " + (open ? "rotate-180" : "")} />
            </button>
          )}
          <Link to={it.route} className="shrink-0" title="Open the page" aria-label="Open the page">
            <ArrowRight size={14} className="text-faint group-hover:text-accent transition" />
          </Link>
        </div>
        {open && expandable && (
          <ul className="border-t border-line/60 dark:border-slate-700/60 divide-y divide-line/40 dark:divide-slate-800/40">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-2.5 pl-9 pr-3 py-1.5 text-[13px]">
                {e.action?.task ? (
                  <button
                    type="button"
                    onClick={() => doneTask.mutate(e.action!.task!)}
                    disabled={doneTask.isPending}
                    title="Mark done"
                    className="shrink-0 w-4 h-4 rounded border border-line dark:border-slate-600 hover:border-accent hover:bg-accent/10 transition flex items-center justify-center"
                  >
                    <CheckCircle2 size={11} className="opacity-0 hover:opacity-100 text-accent" />
                  </button>
                ) : (
                  <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-faint/50" />
                )}
                <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-100">{e.title}</span>
                {e.action?.connection_id && e.action?.device_id && (
                  <span className="shrink-0 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => verdict.mutate({ conn: e.action!.connection_id!, dev: e.action!.device_id!, outcome: "good" })}
                      disabled={verdict.isPending}
                      className="rounded bg-moss-600 hover:bg-moss-700 text-white text-[11px] font-medium px-2 py-0.5 transition"
                    >
                      Good
                    </button>
                    <button
                      type="button"
                      onClick={() => verdict.mutate({ conn: e.action!.connection_id!, dev: e.action!.device_id!, outcome: "scrapped" })}
                      disabled={verdict.isPending}
                      className="rounded border border-ember-300 dark:border-ember-700 text-ember-600 dark:text-ember-400 text-[11px] font-medium px-2 py-0.5 hover:bg-ember-50 dark:hover:bg-ember-950/30 transition"
                    >
                      Scrapped
                    </button>
                  </span>
                )}
              </li>
            ))}
            {it.count > entries.length && (
              <li className="pl-9 pr-3 py-1.5 text-xs text-faint dark:text-slate-500">
                <Link to={it.route} className="hover:text-accent">+{it.count - entries.length} more - open the page</Link>
              </li>
            )}
          </ul>
        )}
      </div>
    </li>
  );
}

// Persisted "where to start" cards from recent bundle installs (the author's #3 — the
// post-install guide that vanished). Each is dismissible once you're oriented.
function SetupCardsPanel({ slug }: { slug: string }) {
  const cards = useSetupCards(slug);
  const navigate = useNavigate();
  // A setup card outlives its bundle: uninstall the bundle and the localStorage
  // card lingered. Cross-check against installed bundles — hide cards whose
  // bundle is gone, and prune them from storage so they don't come back.
  const bundlesQ = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const installed = bundlesQ.data
    ? new Set(bundlesQ.data.items.map((b) => b.external_id))
    : null;
  useEffect(() => {
    if (!installed) return;
    for (const c of cards) {
      if (!installed.has(c.externalId)) dismissSetup(slug, c.externalId);
    }
  }, [installed, cards, slug]);
  // Until bundles load, show what we have (the common case is they're valid);
  // once loaded, only render cards whose bundle is still installed.
  const visible = installed ? cards.filter((c) => installed.has(c.externalId)) : cards;
  if (visible.length === 0) return null;
  return (
    <div className="space-y-3">
      {visible.map((card) => (
        <div
          key={card.externalId}
          className="rounded-xl border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 p-4"
        >
          <div className="flex items-center gap-2 mb-3">
            <Compass size={16} className="text-accent shrink-0" />
            <span className="text-base shrink-0">{card.glyph}</span>
            <div className="font-medium text-content dark:text-mortar-100 min-w-0 truncate">
              Set up {card.name}  - where to start
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
                  <div className="text-sm font-medium text-content dark:text-mortar-100">{liveNextStepLabel(s.path) ?? s.label}</div>
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
  collapsedOnly = false,
}: {
  slug: string;
  enabled: Set<string>;
  modules: OrgModuleListItem[];
  /** Bottom slot: render ONLY the collapsed add-more bar (non-empty
   *  workspaces); the top slot renders only the empty-state hero. */
  collapsedOnly?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { activeOrg } = useActiveOrg();
  // Focused mode: this whole panel is platform onboarding (the bundle wizard,
  // the "browse the marketplace" + "Configuration" cards) — exactly the builder
  // chrome focused mode hides. A focused workspace's empty domains show their
  // OWN add flows, so suppress the platform onboarding entirely here.
  const focused = isFocused(activeOrg);
  // First-run wizard is the default empty-state. "Skip for now" remembers the
  // dismissal per-workspace (device-local) and falls back to the plain
  // action-card panel. The empty-state self-heals once any entity exists, so
  // this flag only matters for a skipped-but-still-empty workspace.
  // Legacy: a workspace dismissed before the onboarding-start redesign falls to
  // the plain action-card panel. Nothing sets this now (the start screen has no
  // "skip"); read-only so old dismissals still resolve.
  const dismissKey = `cobblr.firstRun.dismissed.${slug}`;
  const skippedWizard = (() => {
    try {
      return localStorage.getItem(dismissKey) === "1";
    } catch {
      return false;
    }
  })();
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
      // Module INSTANCES (Yarn, Wardrobe, Outfits…) hold their items under
      // /instances/<name>/items, NOT the base module list — so a workspace whose
      // data lives entirely in instances (most flagship bundles) looked empty
      // here and the first-run wizard never went away. Count instance items too.
      const instances = await api
        .listInstances(slug)
        .then((r) => r.items)
        .catch(() => []);
      // NAMED instances only: default instances are covered by the module
      // probes above, and the defaults of core-* capability modules have no
      // items router at all — probing them 501s on every dashboard load.
      for (const inst of instances.filter((i) => !i.is_default))
        probes.push(wrap(`/instances/${encodeURIComponent(inst.instance_name)}/items?limit=1`));
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
  if (focused) return null; // focused mode: no platform onboarding chrome
  if (enabled.size > 0 && probe.data === undefined) return null; // still probing

  // The guided "What do you want to do?" panel PERSISTS — it no longer vanishes
  // the moment you add your first thing, because the guided add (and the mini
  // scan inbox) are useful for adding MORE, not just the first. Once the
  // workspace has content it renders collapsed (a slim bar that expands), so it
  // stays one click away without dominating an established dashboard.
  if (!skippedWizard) {
    const hasContent = (probe.data ?? 0) > 0;
    // Audit 2026-07-03: the collapsed "Add more" bar lives BELOW the data
    // sections on an established workspace — prime rows belong to the
    // workspace's own state, not a growth affordance. The empty-state hero
    // keeps the top slot.
    // Established workspace: the panel is a growth affordance, not the hero —
    // cap it to a half-column card so expanding it never swallows a full
    // dashboard row (the author, 2026-07-18: "works a lot better as a 1/2 or 1/3
    // width col"). The empty-state hero below keeps full width: on a blank
    // workspace it IS the dashboard.
    // Half-width applies to the GUIDED box only (guidedHalfWidth), not the whole
    // panel: the "waiting to file" scanner strips inside it stay full width. The
    // old max-w-2xl wrapper capped both and dragged the scan section narrow (the author,
    // 2026-07-26).
    if (collapsedOnly)
      return hasContent ? <WhatToDoPanel slug={slug} startCollapsed guidedHalfWidth /> : null;
    if (hasContent) return null;
    return <WhatToDoPanel slug={slug} startCollapsed={false} />;
  }
  if (collapsedOnly) return null;

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
          Welcome - this workspace is empty.
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
            One-click install of a starter pack - Lego, Garden, Tool
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

// The old identity bar (name · slug · role chip · "welcome back" · Customize
// link) is GONE — it spent the dashboard's most valuable row repeating what the
// navbar's workspace switcher already says (the author: "is this bar actually useful
// in any way at all?" — no). What remains: the message strip (bundle-update
// nudges), rendered only when there IS a message, plus a slim "you're a
// {role} here" note on shared workspaces — the one identity fact with signal.
// "Customize workspace" now lives in the workspace switcher's footer.
function WorkspaceHeader({
  slug,
  role,
}: {
  orgName: string;
  slug: string;
  role: string;
  userName: string;
}) {
  const navigate = useNavigate();
  const updates = useBundleUpdates(slug);
  // Bundles the user just updated inline — kept on screen as "Update complete"
  // even after the refetched updates list drops them (the author: "the same thin bar
  // then says Update Complete"). We hold the version so the row can say what it
  // updated TO and keep a "See details" link into the bundle modal — which shows
  // that version's changelog ("what's new"), so the inline one-click update still
  // lets you review what just changed (the author).
  const [completed, setCompleted] = useState<Record<string, { name: string; glyph: string; version: string }>>({});
  const pending = updates.filter((u) => !completed[u.externalId]);
  const completedList = Object.entries(completed);
  const guest = role !== "owner";
  if (pending.length === 0 && completedList.length === 0 && !guest) return null;
  return (
    <header className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900/40 px-4 py-2.5">
      {guest && (
        <div className="text-[11px] text-faint dark:text-slate-400">
          you're a <span className="font-mono uppercase text-accent">{role}</span> in this workspace
        </div>
      )}
      {/* Compact message strip — one line + action per message. Bundle-update
          nudges live here now (the standalone banner was too noisy). Room for
          other one-line messages later. */}
      {(pending.length > 0 || completedList.length > 0) && (
        <div className={"space-y-1" + (guest ? " mt-2 border-t border-line/60 dark:border-slate-800 pt-2" : "")}>
          {pending.map((u) => (
            <BundleUpdateRow
              key={u.externalId}
              slug={slug}
              update={u}
              canApply={role === "owner" || role === "admin"}
              onDone={() =>
                setCompleted((c) => ({ ...c, [u.externalId]: { name: u.name, glyph: u.glyph, version: u.latestV } }))
              }
            />
          ))}
          {completedList.map(([id, c]) => (
            <div key={id} className="flex items-center gap-2 text-xs">
              <CheckCircle2 size={13} className="text-emerald-500 dark:text-emerald-400 shrink-0" />
              <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-200">
                {c.glyph} <strong>{c.name}</strong>{" "}
                <span className="text-faint dark:text-slate-500">updated to v{c.version}</span>
              </span>
              <button
                type="button"
                onClick={() =>
                  navigate(
                    `/bundles?open=${encodeURIComponent(id)}&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
                  )
                }
                className="shrink-0 text-accent hover:underline font-medium"
              >
                See details
              </button>
            </div>
          ))}
        </div>
      )}
    </header>
  );
}

// Guard so an auto-applied (patch/minor) update fires AT MOST ONCE per
// (workspace, bundle, target version) — even across the remounts a bundles
// refetch causes. A failed auto-apply is NOT retried (the key stays set): the
// row falls back to its manual controls rather than looping the apply against
// live workspace data. Module-level so it survives BundleUpdateRow remounts.
const autoAppliedUpdates = new Set<string>();

// One bundle-update line in the dashboard header strip.
//
// Update FLOW is decided by the SemVer delta (owner-approved policy — see
// lib/bundleUpdateTier.ts):
//   • PATCH  → silent auto-apply. No toast; audited via the server's
//              `bundle_installed` activity-log entry (applyValidatedBundle).
//   • MINOR  → auto-apply + a toast naming what was added.
//   • MAJOR / non-semver / ambiguous → the existing explicit prompt. NEVER
//              silent.
//
// SAFETY GATE: auto-apply (patch/minor) only runs when the inline apply is
// provably safe for THIS workspace — validateBundle reports no upgrade
// conflicts (a field the user customised that the new version changes/removes
// routes to the modal), and the apply itself doesn't hit needs_enable /
// field_def_collision (those throw → we fall back to the prompt, never guess).
// A conflict-free update applies inline (one POST, no modal — feedback
// e429a627); the only change here is that patch/minor no longer need the click.
function BundleUpdateRow({
  slug,
  update,
  canApply,
  onDone,
}: {
  slug: string;
  update: BundleUpdate;
  /** Whether this viewer may apply updates (owner/admin). Auto-apply never
   *  fires for a guest — the install endpoint would 403 and loop. */
  canApply: boolean;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  // A catalog-bearing update NEVER auto-applies. Gate on BOTH manifests: the
  // DROP case (installed shipped a catalog the new version removed) still tears
  // the catalog down on a pre-fix api, and the new manifest alone can't reveal
  // it. The server now self-heals (uninstallBundleId only deletes catalogs on a
  // real uninstall), so this is the rollout-window backstop, not the permanent
  // guard. Demand an explicit confirm rather than risk dropping user data.
  const shipsCatalogs = updateMayTeardownCatalogs(update.installedManifest, update.manifest);
  const tier = shipsCatalogs ? "prompt" : classifyBundleUpdate(update.installedV, update.latestV);
  const autoKey = `${slug}:${update.externalId}@${update.latestV}`;

  const preview = useQuery({
    queryKey: ["bundle-update-preview", slug, update.externalId, update.latestV],
    queryFn: () => api.validateBundle(slug, update.manifest),
    enabled: !!slug,
    staleTime: 60_000,
  });
  const hasConflict = (preview.data?.preview?.upgrade_conflicts?.length ?? 0) > 0;
  // Preview came back AND nothing the user customised collides → the inline
  // apply is safe to take without routing through the modal.
  const previewClean = !!preview.data && !hasConflict;

  function openModal() {
    navigate(
      `/bundles?open=${encodeURIComponent(update.externalId)}&returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
  }

  const install = useMutation({
    mutationFn: (_vars: { silent: boolean }) =>
      api.installBundle(slug, update.manifest, false, update.enabledFeatures),
    onSuccess: (r, vars) => {
      // PATCH auto-apply is silent (no toast) — still auditable via the
      // server-side `bundle_installed` activity entry. MINOR + any manual
      // click get a toast; MINOR names what landed so the user knows what's new.
      if (!vars.silent) {
        const bits = [
          r.applied.field_defs ? `${r.applied.field_defs} field${r.applied.field_defs === 1 ? "" : "s"}` : null,
          r.applied.wires ? `${r.applied.wires} automation${r.applied.wires === 1 ? "" : "s"}` : null,
        ].filter(Boolean);
        toast.success(
          `Updated ${r.bundle.name} to v${r.bundle.version}` + (bits.length ? `. Added ${bits.join(", ")}.` : "."),
        );
      }
      // Mirror BundleDetailModal's post-install refresh — an update can move
      // field defs / wires / instances, so the same queries must invalidate.
      for (const key of ["bundles", "bindings", "field-defs", "org-modules", "instances", "entity-kind-overrides"]) {
        void qc.invalidateQueries({ queryKey: [key, slug] });
      }
      onDone();
    },
  });

  async function runUpdate(silent: boolean) {
    try {
      await install.mutateAsync({ silent });
    } catch (e) {
      // Anything that needs a decision (module-enable / field collision /
      // unexpected) is NEVER resolved silently. A manual click routes to the
      // modal; a silent auto-apply just stops and lets the row fall back to its
      // manual controls (the autoAppliedUpdates guard prevents a re-fire), so
      // the user is never yanked into a modal they didn't ask for.
      if (e instanceof ApiError && (e.code === "needs_enable" || e.code === "field_def_collision")) {
        if (!silent) openModal();
        return;
      }
      if (!silent) toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  // Auto-apply patch/minor once the preview is clean. Guarded so it fires at
  // most once per target version and never for a guest.
  useEffect(() => {
    if (!canApply) return;
    if (!tierAutoApplies(tier)) return; // major / non-semver → manual prompt only
    if (!previewClean) return; // wait for a clean, conflict-free preview
    if (install.isPending || install.isSuccess) return;
    if (autoAppliedUpdates.has(autoKey)) return;
    autoAppliedUpdates.add(autoKey);
    void runUpdate(tier === "patch"); // patch: silent · minor: toast
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApply, tier, previewClean, autoKey]);

  const updateNow = () => void runUpdate(false);

  const version = (
    <>
      {update.glyph} <strong>{update.name}</strong>{" "}
      <span className="text-faint dark:text-slate-500">
        v{update.installedV} → v{update.latestV}
      </span>
    </>
  );

  return (
    <div className="flex items-center gap-2 text-xs">
      <ArrowUpCircle size={13} className="text-amber-500 dark:text-amber-400 shrink-0" />
      <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-200">{version}</span>
      {install.isPending ? (
        <span className="shrink-0 text-faint dark:text-slate-500">Updating…</span>
      ) : preview.isPending ? (
        // While the preview loads: an auto tier (patch/minor) is about to apply
        // itself, so show a passive "Checking…" rather than a manual action.
        canApply && tierAutoApplies(tier) ? (
          <span className="shrink-0 text-faint dark:text-slate-500">Checking…</span>
        ) : (
          <button
            type="button"
            onClick={openModal}
            className="shrink-0 text-accent hover:underline font-medium"
          >
            See details
          </button>
        )
      ) : hasConflict ? (
        <button
          type="button"
          onClick={openModal}
          className="shrink-0 text-accent hover:underline font-medium"
        >
          Resolve conflict to update
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={updateNow}
            className="shrink-0 text-accent hover:underline font-medium"
          >
            Update now
          </button>
          <span className="shrink-0 text-faint dark:text-slate-600">·</span>
          <button
            type="button"
            onClick={openModal}
            className="shrink-0 text-muted dark:text-slate-400 hover:underline"
          >
            See details
          </button>
        </>
      )}
    </div>
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

// The dashboard's arrangeable sections, in default order. `scan_inbox` (the
// "what do you want to do" + waiting-to-file capture queue) sits ABOVE recent
// activity: a scan backlog is actionable workspace state, not a growth
// afterthought, so it's demoted no lower than recent activity (the author, 2026-07-10).
const SECTION_IDS = ["at_a_glance", "pinned_views", "scan_inbox", "recent_activity"] as const;
type SectionId = (typeof SECTION_IDS)[number];
const SECTION_TITLE: Record<SectionId, string> = {
  at_a_glance: "at a glance",
  pinned_views: "your views",
  scan_inbox: "from your scanner",
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
  // The user's saved sections, in their saved order.
  const result = SECTION_IDS.filter((id) => saved.has(id))
    .sort((a, b) => saved.get(a)!.i - saved.get(b)!.i)
    .map<SectionDraft>((id) => ({ id, hidden: saved.get(id)!.hidden }));
  // A section added AFTER the user last arranged (e.g. scan_inbox) slots in at
  // its DEFAULT-order neighbour, not appended last — so an already-arranged
  // dashboard still gets it where it belongs (scan_inbox above recent activity),
  // visible. Insert before the first saved section that follows it by default.
  for (const id of SECTION_IDS) {
    if (saved.has(id)) continue;
    const di = SECTION_IDS.indexOf(id);
    let pos = result.findIndex((s) => SECTION_IDS.indexOf(s.id) > di);
    if (pos < 0) pos = result.length;
    result.splice(pos, 0, { id, hidden: false });
  }
  return result;
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
  modules,
}: {
  slug: string;
  enabled: Set<string>;
  role: string;
  modules: OrgModuleListItem[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const registered = useDashboardWidgets().filter((w) => enabled.has(w.module));
  // Modules that want one tile per instance ("Yarn"/"Hooks", not "Inventory").
  // Fetch their instances and expand each into per-instance specs; everything
  // else passes through as its single aggregate tile.
  const instanceModules = registered.filter((w) => w.instanceTile).map((w) => w.module);
  const instanceQs = useQueries({
    queries: instanceModules.map((m) => ({
      queryKey: ["dash-instances", slug, m],
      queryFn: () => api.listInstances(slug, m).then((r) => r.items),
      enabled: !!slug,
      staleTime: 30_000,
    })),
  });
  const instancesByModule = new Map(
    instanceModules.map((m, i) => [m, instanceQs[i]?.data] as const),
  );
  const widgets = expandInstanceWidgets(registered, instancesByModule);
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
    if (id === "scan_inbox")
      // The "what do you want to do" + waiting-to-file capture queue, now a
      // first-class section above recent activity (was demoted below everything).
      return <GettingStartedPanel slug={slug} enabled={enabled} modules={modules} collapsedOnly />;
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
  // Zero-tile collapse (audit 2026-07-03): empty tiles vanish from the grid
  // and reappear as one quiet "Also enabled" line — a workspace with three
  // empty modules stops burning a tile row on zeros. Arrange mode shows every
  // tile (you can still hide/reorder empties there).
  const [empties, setEmpties] = useState<Map<string, string>>(new Map());
  const reportEmpty = useCallback((label: string, to: string, empty: boolean) => {
    setEmpties((prev) => {
      const has = prev.has(label);
      if (empty === has && (!empty || prev.get(label) === to)) return prev;
      const next = new Map(prev);
      if (empty) next.set(label, to);
      else next.delete(label);
      return next;
    });
  }, []);
  const collapseCtx = useMemo(() => ({ editing, reportEmpty }), [editing, reportEmpty]);

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
            All tiles are hidden - use Arrange to show some.
          </p>
        ) : (
          <TileCollapseContext.Provider value={collapseCtx}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {visible.map((a) => {
              const Widget = a.spec.component;
              // `empty:hidden` — a tile that collapses to null (DashboardTile
              // returns null when empty) leaves its wrapper :empty; hide it so it
              // stops holding a grid cell. Without this, empty tiles occupy cells
              // and shove the one non-empty tile to a stray column (the "why is my
              // lone Projects card floating on the right" bug).
              return (
                <div key={widgetId(a.spec)} className={(spanCls(a.span) + " empty:hidden").trim()}>
                  <Widget slug={slug} getToken={getToken} instance={a.spec._instance} />
                </div>
              );
            })}
          </div>
          {empties.size > 0 && (
            <p className="mt-2 text-xs text-faint dark:text-slate-500">
              {/* "Also enabled" only reads right when there ARE populated tiles
                  above for it to be "also" to. When every module is empty the
                  grid renders nothing, so "also" is orphaned (the author, 2026-07-05) —
                  drop it to a plain "Enabled". */}
              {empties.size >= visible.length ? "Enabled:" : "Also enabled:"}{" "}
              {[...empties.entries()].map(([label, to], i) => (
                <span key={label}>
                  {i > 0 && " · "}
                  <Link to={to} className="lowercase hover:text-accent underline decoration-dotted underline-offset-2">
                    {label}
                  </Link>
                </span>
              ))}
              <span>  - nothing in them yet.</span>
            </p>
          )}
          </TileCollapseContext.Provider>
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
              <Widget slug={slug} getToken={getToken} instance={a.spec._instance} />
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

function PinnedViewsGhost({ slug }: { slug: string }) {
  const key = `cobblr.pinnedViewsGhost.dismissed.${slug}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  if (dismissed) return null;
  return (
    <section>
      <SectionTitle>your views</SectionTitle>
      <div className="rounded-xl border-2 border-dashed border-line dark:border-slate-700 px-4 py-3 flex items-center gap-3">
        <Pin size={15} className="shrink-0 text-faint dark:text-slate-500" />
        <div className="flex-1 min-w-0 text-sm text-muted dark:text-slate-400">
          <Link to="/views" className="text-accent hover:underline font-medium">Pin a saved view</Link>
          {" "}here - your table, your filters, live on the dashboard.
        </div>
        <button
          type="button"
          onClick={() => { setDismissed(true); try { localStorage.setItem(key, "1"); } catch { /* ignore */ } }}
          className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-200 transition"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </section>
  );
}

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
  // When arranging, the section bar (ArrangeableBody) supplies the title, and
  // an empty section must still show SOMETHING so it stays reorderable.
  if (pinned.length === 0) {
    if (editing)
      return <p className="text-xs text-faint dark:text-slate-500 italic">No pinned views yet.</p>;
    // Ghost card (prototype, the author sign-off pending): the section used to hide
    // entirely when nothing was pinned, so most users never learned it exists.
    // One dismissible dashed invitation; gone forever once dismissed or once
    // anything is pinned.
    return <PinnedViewsGhost slug={slug} />;
  }
  return (
    <section>
      {!editing && (
        <div className="flex items-center gap-2 mb-2">
          <SectionTitle>your views</SectionTitle>
        </div>
      )}
      {/* Always the 2-up grid. The old full/half toggle only changed the column
          count — the cards render identically either way (each AS its own type),
          so it added no real choice (the author, 2026-07-10). */}
      <div className="grid gap-3 md:grid-cols-2">
        {pinned.map((v) => (
          <PinnedView key={v.id} slug={slug} view={v} />
        ))}
      </div>
    </section>
  );
}

// One poster in a gallery-view carousel. Routes the image through useImageSrc
// so the auth-gated /raw file URL is bearer-fetched into a blob (a plain <img>
// would 401). Falls back to a title initial.
function PosterCell({ path, title }: { path: string | null; title: string }) {
  const src = useImageSrc(path);
  return (
    <div className="shrink-0 w-28" title={title}>
      <div className="aspect-[2/3] rounded-md overflow-hidden bg-subtle dark:bg-slate-800 flex items-center justify-center ring-1 ring-line dark:ring-slate-700">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-bold text-faint dark:text-slate-600">{title.slice(0, 1).toUpperCase()}</span>
        )}
      </div>
    </div>
  );
}

/** Is a grouped view's distribution worth drawing? It needs at least TWO buckets
 *  to BE a distribution: when every item shares one value ("By make" over a single
 *  Honda), the lone 100% bar restates the count already in the header and never
 *  says WHAT you have — "HONDA 1" where "2019 Honda Civic" was the useful answer
 *  (the author, 2026-07-16). One bucket → fall through to the item list. A lone SET
 *  bucket plus unset items still counts as spread (it shows what's missing).
 *
 *  ALL-UNSET does not: an earlier revision kept the distribution branch for it
 *  and rendered only a "set tube type to group them here" hint — a card with
 *  five laser cutters behind it and zero content ("still 100% useless", the author,
 *  2026-07-18). The hint is right; hiding the items to show it is not. All-unset
 *  now falls to the item list, which carries the hint as a footer.
 *  `groupCounts` is [value, n] with "" as the unset bucket. Exported for the test
 *  that pins this rule. */
export function shouldShowDistribution(
  isGrouped: boolean,
  groupCounts: Array<[string, number]>,
): boolean {
  const setBucketCount = groupCounts.filter(([k]) => k !== "").length;
  const unsetCount = groupCounts.find(([k]) => k === "")?.[1] ?? 0;
  return isGrouped && (setBucketCount >= 2 || (setBucketCount >= 1 && unsetCount > 0));
}

function PinnedView({
  slug,
  view,
}: {
  slug: string;
  view: SavedView;
}) {
  // A pinned view previews AS ITS TYPE: a gallery shows a horizontal poster
  // strip, a heatmap shows its grid, and a GROUPED view (kanban / any group_by)
  // shows its group DISTRIBUTION — "functional 30 · rebuilding 12 · …", the point
  // of the view — instead of a flat thumb+title list that looked identical to
  // every other type (the author, 2026-07-10). Only plain list/table fall back to the
  // list.
  const isGallery = view.view_type === "gallery";
  const isHeatmap = view.view_type === "heatmap";
  const groupBy = typeof view.config?.group_by === "string" ? (view.config.group_by as string) : null;
  const isGrouped = !!groupBy && !isGallery && !isHeatmap;
  const data = useQuery({
    // Grouped previews fetch enough rows to count the groups (workshop-scale;
    // capped so a huge view stays cheap). Non-grouped keep the light default.
    queryKey: ["dash-view-data", slug, view.id, isGrouped ? "grouped" : "preview"],
    // paginate-ok: bounded dashboard preview, a 500-row group-count sample for the distribution bars, not a full list.
    queryFn: () => api.viewData(slug, view.id, isGrouped ? { limit: 500 } : undefined),
    staleTime: 30_000,
  });
  const routeFor = useDetailRoute(slug);
  const allItems = data.data?.items ?? [];
  const items = allItems.slice(0, 5);
  const imgField = (view.config?.image_field as string) || "image_path";
  // Group counts, highest first. Group STRICTLY by the view's group_by field —
  // an empty value is its own "unset" bucket ("" key), NOT the row subtitle. The
  // old subtitle fallback conflated an unset group with a DIFFERENT field: a
  // "Laser fleet by tube type" view whose lasers had no tube_type showed their
  // STATE ("functional/building") as if it were the tube type (the author, 2026-07-10).
  const groupCounts = useMemo<Array<[string, number]>>(() => {
    if (!isGrouped || !groupBy) return [];
    const m = new Map<string, number>();
    for (const r of allItems) {
      const raw = r.fields?.[groupBy] as unknown;
      const key = raw == null || raw === "" ? "" : String(raw); // "" = unset
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [isGrouped, groupBy, allItems]);
  const showDistribution = shouldShowDistribution(isGrouped, groupCounts);
  // A readable label for the grouping field, for the "nothing set yet" hint.
  const groupLabel = groupBy ? groupBy.replace(/_/g, " ") : "";
  // WHAT is this card about? A view name is a lens, not a subject: "By make"
  // alone never says by make of WHAT (the author, 2026-07-16), and on a dashboard of
  // pinned cards the subject is the thing you scan for. Resolve it from the
  // view's kind. Same lookup fixes the noun: taking the kind's suffix reads the
  // literal "item" for an INSTANCE kind (`vehicles:item`), which is why the card
  // said "1 item" about a car. An instance knows its own name and noun; ask it.
  // (Shares App's ["instances", slug] cache key, so this costs no extra fetch.)
  const instancesQ = useQuery({
    queryKey: ["instances", slug],
    queryFn: () => api.listInstances(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const entityKind = data.data?.view?.entity_kind ?? "";
  const kindHead = entityKind.split(":")[0] ?? "";
  const kindTail = entityKind.split(":")[1] ?? "";
  const instance = (instancesQ.data?.items ?? []).find((i) => i.instance_name === kindHead);
  // The instance's display name ("Vehicles"); a plain module kind has no instance
  // and its type suffix already reads as the subject (assets:asset → asset).
  const subject = instance?.display_name ?? "";
  const configNoun = instance?.config?.item_noun;
  const kindNoun =
    (typeof configNoun === "string" && configNoun) ||
    (subject ? subject.replace(/s$/i, "").toLowerCase() : kindTail);
  const countLabel = kindNoun
    ? `${allItems.length} ${kindNoun}${allItems.length === 1 ? "" : "s"}`
    : `${allItems.length}`;
  const galleryImg = (r: (typeof allItems)[number]): string | null => {
    // Mirror the modal's fieldVal: custom + native fields live under `fields`
    // (and native image_path is also mirrored there), with a top-level fallback.
    const meta = r.fields?.metadata as Record<string, unknown> | undefined;
    const v = (r.fields?.[imgField] ?? meta?.[imgField]) as unknown;
    if (typeof v === "string" && v) return v;
    return r.image_path ?? null;
  };
  return (
    // min-w-0: this card is a GRID CHILD, whose min-width defaults to its
    // content's intrinsic width — a long view name or item title silently
    // stretched the card past the phone viewport, defeating every `truncate`
    // inside (the title row's min-w-0 is powerless if the card itself grew).
    // e2e/mobile-overflow.mjs guards the class.
    <div className="min-w-0 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex items-baseline gap-2 mb-2 min-w-0">
        <LayoutList size={13} className="text-accent shrink-0" />
        {/* Subject FIRST, then the lens: "Vehicles · By make". The view name on
            its own is a grouping, not an answer to "what is this card?".
            The NAMES own the row: the view-type chip is gone (the card already
            renders AS its type, so "KANBAN" restated what the bars show), and
            the count never wraps — "3D Print… · Printer fleet by st…" next to a
            fully-readable KANBAN chip was the wrong things truncating
            (the author, 2026-07-18). */}
        {subject && (
          <>
            <span className="font-medium text-content dark:text-mortar-100 truncate shrink-[2] min-w-[4rem]">{subject}</span>
            <span className="text-faint shrink-0">·</span>
          </>
        )}
        <Link
          to={`/views/${view.id}`}
          className={`truncate min-w-0 flex-1 hover:text-accent ${
            subject
              ? "text-muted dark:text-slate-400"
              : "font-medium text-content dark:text-mortar-100"
          }`}
        >
          {view.name}
        </Link>
        <span className="text-[10px] font-mono text-faint shrink-0 whitespace-nowrap">
          {countLabel}
        </span>
      </div>
      {data.isLoading && (
        <div className="text-xs text-faint">loading…</div>
      )}
      {!data.isLoading && items.length === 0 && (
        <div className="text-xs text-faint italic">no matching rows</div>
      )}
      {/* Each card ALWAYS renders as its own type — a heatmap is always a
          heatmap, never a degraded row list. Non-visual types (list/table/…)
          preview as a compact thumb+title list. */}
      {!data.isLoading && items.length > 0 && (
        showDistribution ? (
          // The group distribution — the whole point of a "by state" / "by type"
          // view. shouldShowDistribution guarantees at least one populated
          // bucket here; the all-unset case falls to the item list below (which
          // carries the "set it to group" hint), so this card is never a
          // hint-only dead card again.
          (() => {
            const setGroups = groupCounts.filter(([k]) => k !== "");
            const unset = groupCounts.find(([k]) => k === "")?.[1] ?? 0;
            return (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {setGroups.map(([label, n]) => (
                  <div key={label} className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-sm text-content dark:text-mortar-100 capitalize truncate">{label}</span>
                      <span className="font-mono text-xs text-faint tabular-nums">{n}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-subtle dark:bg-slate-800 overflow-hidden" style={{ width: "5rem" }}>
                      <div
                        className="h-full bg-accent/60"
                        style={{ width: `${allItems.length ? Math.round((n / allItems.length) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
                {unset > 0 && (
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-sm text-faint italic truncate">no {groupLabel}</span>
                      <span className="font-mono text-xs text-faint tabular-nums">{unset}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-subtle dark:bg-slate-800 overflow-hidden" style={{ width: "5rem" }}>
                      <div className="h-full bg-line dark:bg-slate-600" style={{ width: `${allItems.length ? Math.round((unset / allItems.length) * 100) : 0}%` }} />
                    </div>
                  </div>
                )}
              </div>
            );
          })()
        ) : isGallery ? (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {allItems.slice(0, 20).map((r) => (
              <PosterCell key={`${r.kind}:${r.id}`} path={galleryImg(r)} title={r.title} />
            ))}
          </div>
        ) : isHeatmap ? (
          <HeatmapRenderer items={allItems} cfg={view.config ?? {}} />
        ) : (
          <>
            <ul className="space-y-1.5">
              {items.map((r) => {
                // Row → the entity's detail page (registry-driven; instance
                // kinds resolve too). No route registered → plain row.
                const href = routeFor(r.kind, r.id);
                const body = (
                  <>
                    <EntityThumb src={r.image_path} alt={r.title} size={40} />
                    <div className="min-w-0">
                      <div className="truncate text-content dark:text-mortar-100 group-hover/row:text-accent">
                        {r.title}
                      </div>
                      {r.subtitle && <div className="text-xs text-muted truncate">{r.subtitle}</div>}
                    </div>
                  </>
                );
                return (
                  <li key={`${r.kind}:${r.id}`} className="text-sm">
                    {href ? (
                      <Link to={href} className="flex items-center gap-3 group/row">
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* A grouped view whose group field is unset everywhere lands here
                (shouldShowDistribution says no spread). Show the items — they
                ARE the content — and teach the grouping as a footer, instead of
                the hint-only dead card this used to be. */}
            {isGrouped && groupCounts.length > 0 && groupCounts.every(([k]) => k === "") && (
              <div className="mt-2 text-[11px] text-faint italic">
                No {groupLabel} set yet - set it on these to group them here.
              </div>
            )}
          </>
        )
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
        // Capped + scrollable: recent activity was the single longest element on
        // the page (it renders every group), so it's bounded to a fixed height and
        // scrolls internally — glanceable without dominating the page (the author,
        // 2026-07-26).
        <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800 max-h-[28rem] overflow-y-auto">
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
  return (
    <li className="px-3 py-2 flex items-baseline gap-1.5 text-sm">
      <span className="text-muted dark:text-slate-400 shrink-0">
        {actorLabel(e)}
      </span>
      <span className="text-content dark:text-mortar-200 shrink-0">
        {humanAction(e.action)}
      </span>
      <span className="text-content dark:text-mortar-100 truncate min-w-0">
        {activityTitle(e)}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-faint shrink-0">
        {relativeTime(e.occurred_at)}
      </span>
    </li>
  );
}

/** Consolidated row for a burst of N identical-signature entries.
 *  Shows one summary line + a `×N` chip that always expands to reveal
 *  each underlying entry — so a "deleted ×3" can be opened to see the
 *  three specific things. Each child row falls back to its entity_type
 *  + timestamp when its diff carries no title, so the burst is always
 *  inspectable even without per-item names. */
function ActivityGroupRow({ group }: { group: ActivityGroup }) {
  // Guaranteed non-empty: ActivityGroup is only constructed inside
  // groupActivity which always pushes at least one item before the
  // group is recorded; and the caller only renders this for groups
  // with length > 1.
  const first = group.items[0]!;
  const last = group.items[group.items.length - 1]!;
  const action = humanAction(first.action);
  const actor = actorLabel(first);
  // The summary must not LIE: "created K1 Max ×2" for two different machines
  // read as two copies of K1 Max. Distinct identities → summarize by entity kind
  // ("2 machines"); identical → keep the identity (a true ×N of one thing).
  // Wires carry no title/name/label — their identity is the "<event> → <action>"
  // path, so a burst of identical wire-fires collapses to that path instead of a
  // bare "N bindings —" with nothing after the dash (feedback 6c87c6e2).
  const ids = group.items.map(activityIdentity);
  const allSame = ids.every((t) => t === ids[0] && t !== "");
  const noun = (first.entity_type ?? "item").split(":").pop()!.replace(/[_-]/g, " ");
  const distinct = [...new Set(ids.filter(Boolean))];
  const summary = allSame ? (
    <>{activityTitle(first)}</>
  ) : (
    <>
      <strong>{group.items.length}</strong> {noun}
      {group.items.length === 1 ? "" : "s"}
      {distinct.length > 0 && (
        <span className="text-faint dark:text-slate-400"> — {distinct.slice(0, 2).join(", ")}{distinct.length > 2 ? ", …" : ""}</span>
      )}
    </>
  );
  const spanStart = relativeTime(last.occurred_at);
  const spanEnd = relativeTime(first.occurred_at);
  const rowContent = (
    <div className="flex items-baseline gap-1.5 text-sm w-full min-w-0">
      <span className="text-muted dark:text-slate-400 shrink-0">
        {actor}
      </span>
      <span className="text-content dark:text-mortar-200 shrink-0">
        {action}
      </span>
      <span className="text-content dark:text-mortar-100 truncate min-w-0">
        {summary}
        {allSame && (
          <span className="ml-1.5 inline-flex items-center text-[10px] font-mono uppercase tracking-widest text-accent dark:text-cobble-400 bg-cobble-50 dark:bg-cobble-900/40 rounded px-1.5 py-0.5">
            ×{group.items.length}
          </span>
        )}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-faint shrink-0">
        {spanStart === spanEnd ? spanStart : (
          <>
            {spanStart}
            <span className="text-faint dark:text-slate-600"> → </span>
            {spanEnd}
          </>
        )}
      </span>
    </div>
  );
  return (
    <li>
      <details className="group">
        <summary className="list-none cursor-pointer px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800/40 transition flex items-baseline gap-2">
          <span className="text-faint dark:text-slate-600 text-[10px] shrink-0 group-open:rotate-90 transition-transform">▸</span>
          {rowContent}
        </summary>
        <ul className="border-t border-line dark:border-slate-800 bg-mortar-25 dark:bg-slate-800/20 divide-y divide-line dark:divide-slate-800/40 pl-6 border-l-2 border-l-line dark:border-l-slate-700">
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

// Actions the system performs on its own — no human did them, so "someone" is
// wrong. They get an "Automation" actor instead.
const AUTOMATION_ACTIONS = new Set(["wire_fired", "wire_failed"]);

/** Who to credit a row to: the real user, else "Automation" for system actions,
 *  else a neutral "someone". */
function actorLabel(e: ActivityEntry): string {
  return e.actor?.display_name ?? (AUTOMATION_ACTIONS.has(e.action) ? "Automation" : "someone");
}

/** Drop a "module:" namespace from an id for display (core-notifications:notify → notify). */
function shortActionId(id: string): string {
  const i = id.indexOf(":");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** The "what" cell. Wires carry no name/title, so build an "<event> → <action>"
 *  summary from their diff (e.g. "inventory.part.low_stock → notify") instead of
 *  the bare "binding" entity_type. Everything else uses its create-time title,
 *  falling back to the entity_type. */
function activityTitle(e: ActivityEntry): React.ReactNode {
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  if (AUTOMATION_ACTIONS.has(e.action)) {
    const event = pickString(diff, ["event"]);
    const act = pickString(diff, ["action"]);
    if (event || act) {
      return (
        <span className="font-mono text-xs">
          {event ?? "event"}
          <span className="text-faint"> → </span>
          {act ? shortActionId(act) : "action"}
        </span>
      );
    }
  }
  // Diff title (creates carry one) → server-resolved live-record title (updates)
  // → bare entity_type (deleted / unresolvable).
  const title = pickString(diff, ["name", "title", "label"]) ?? e.entity_title;
  return title ?? <span className="font-mono text-xs text-faint">{e.entity_type}</span>;
}

/** A stable plain-text identity for burst summarization — the string form of
 *  what activityTitle() renders. Wires have no title/name/label, so their
 *  identity is the "<event> → <action>" path; everything else falls back to its
 *  create-time title. Empty when neither exists (never counts as "same"). */
function activityIdentity(e: ActivityEntry): string {
  const diff = (e.diff ?? {}) as Record<string, unknown>;
  if (AUTOMATION_ACTIONS.has(e.action)) {
    const event = pickString(diff, ["event"]);
    const act = pickString(diff, ["action"]);
    if (event || act) return `${event ?? "event"} → ${act ? shortActionId(act) : "action"}`;
  }
  return pickString(diff, ["name", "title", "label"]) ?? "";
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
    wire_fired: "ran a wire",
    wire_failed: "wire failed",
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
