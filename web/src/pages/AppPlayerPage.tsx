// App Player — renders a WorkspaceApp (H1, Tier A) for a worker in the
// member portal. The app is a structured composition: pages → blocks.
// Every block resolves through the kernel's capability + field-read-
// scope (H2) boundary — a `view` block shows only the fields the
// viewer's capabilities allow (parts, not prices), with zero per-app
// work. The player just orchestrates the existing view/entity/action
// endpoints; it has no privileged data path.
//
// This file ships the standalone blocks (view / stat / markdown). The
// interactive blocks (action / form / record / scan) land next; an
// unknown/not-yet-supported block renders a small placeholder rather
// than breaking the page.

import { appInvokeRequest } from "../lib/app-invoke";
import { useViewData } from "../lib/useViewData";
import { ViewMore } from "../components/ViewMore";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Plus, ScanLine, LogOut, LayoutDashboard, LayoutGrid, ChevronDown } from "lucide-react";
import { MarkdownText, sendUpload } from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import { useRunAction, undoStepsOf, AskBeforeRun, type Asking, EntityActionsBar, EntityThumb, usePageTitle, useToast, OverlayLayer, BackdropLayer } from "@cobblr/platform-web";
import { NewPartDialog, InventoryProvider } from "@cobblr/inventory/ui";
import { api, getToken, type AppBlock, type AppTheme } from "../lib/api";
import { frameDocUrl } from "../lib/frame-doc";
import { createCapabilityForKind } from "@cobblr/platform-contract/create-capability";
import { askBeforePress, pressAnswersToArgs } from "@cobblr/platform-contract/action-args";
import { statValue } from "@cobblr/platform-contract/stat-value";
import { AskForItButton } from "../components/AskForItButton";
import { AppEditForm } from "../components/AppEditForm";
// Per-surface theme → CSS variables. Shared with the member portal so the
// launcher can wear the same brand. See web/src/lib/appTheme.ts.
import {
  accentStyle,
  btnStyle,
  cardStyle,
  CUSTOM_FONT_FAMILY,
  customFontUrl,
  FONT_STACKS,
  fontFaceCss,
  mutedStyle,
  proseStyle,
  textStyle,
  themeWrapperStyle,
} from "../lib/appTheme";
import { withArticle } from "@cobblr/platform-contract/plural";
import { useCapabilitiesFor } from "../lib/can";

interface Caps {
  role: string;
  /** The server's answer to "holds every capability implicitly" — the
   *  admin tier, by rank. Read, never re-derived from the role name. */
  all: boolean;
  grants: string[];
}
/** Can the viewer perform an action? The admin tier always; else an
 *  explicit grant. Reads the server's requireCapability answer so the
 *  worker app only shows affordances the member can actually use. */
function canDo(caps: Caps | undefined, actionId: string | undefined): boolean {
  if (!actionId) return false;
  if (!caps) return false;
  return caps.all || caps.grants.includes(actionId);
}
/** Per-kind create dialog. The capability behind it is the contract's answer
 *  (create-capability.ts), the same one the portal and the scan inbox read. */

export function AppPlayerPage() {
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>();
  const [pageIdx, setPageIdx] = useState(0);
  const { user, logout } = useAuth();

  const app = useQuery({
    queryKey: ["app", slug, appSlug],
    queryFn: () => api.getApp(slug!, appSlug!),
    enabled: !!slug && !!appSlug,
  });
  const caps = useCapabilitiesFor(slug);
  usePageTitle(app.data?.name ?? "App");

  if (!slug || !appSlug) return null;
  if (app.isLoading)
    return <div className="text-xs text-faint italic p-6">Loading…</div>;
  if (app.error || !app.data) {
    return (
      <div className="space-y-4">
        {/* The launcher, never the portal root: a portal with one app (or a
            default one) lands straight back in it, so Back looped (#6044). */}
        <Link
          to={`/portal/${slug}?all=1`}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-accent"
          data-testid="app-back"
        >
          <ArrowLeft size={12} /> All apps
        </Link>
        <div className="text-sm text-muted py-8 text-center" data-testid="app-unavailable">
          <p className="italic">This app isn't available to you.</p>
          <p className="mt-1">Ask whoever runs this workspace to share it with you, or open another app from All apps.</p>
        </div>
      </div>
    );
  }

  const pages = app.data.pages ?? [];
  const page = pages[pageIdx] ?? pages[0];
  const theme = app.data.theme ?? null;

  // Page-tabs (only when >1 page) + the block stack — shared between the
  // in-portal (unthemed) and full-bleed (themed) shells.
  const tabsEl = pages.length > 1 && (
    <div role="tablist" aria-label="Pages" className="flex flex-wrap gap-1 mt-2">
      {pages.map((p, i) => (
        <button
          key={p.slug}
          type="button"
          role="tab"
          aria-selected={i === pageIdx}
          onClick={() => setPageIdx(i)}
          className={
            "min-h-11 inline-flex items-center gap-1 px-3 rounded-md text-sm transition " +
            (i === pageIdx
              ? "bg-cobble-600 text-white"
              : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800")
          }
          style={i === pageIdx ? btnStyle(theme) : mutedStyle(theme)}
        >
          {i === pageIdx && <Check size={14} strokeWidth={2.5} aria-hidden data-picked-mark />}
          {p.title}
        </button>
      ))}
    </div>
  );
  const blocksEl =
    !page || page.blocks.length === 0 ? (
      <div className="text-xs text-faint italic py-8 text-center" style={mutedStyle(theme)}>
        This page has no blocks yet.
      </div>
    ) : (
      <div className="space-y-5">
        {page.blocks.map((block, i) => (
          <BlockRenderer key={i} slug={slug} appSlug={appSlug} block={block} caps={caps ?? undefined} theme={theme} />
        ))}
      </div>
    );

  // ── Themed → full-bleed standalone app ──
  // A theme means "this should look like the builder's app, not Cobblr."
  // So it OWNS the viewport: a fixed, theme-coloured surface portaled to
  // <body> (escaping the portal shell's backdrop-blur trap) covers the
  // Cobblr header + background entirely. The themed top bar carries the
  // app's own logo/name AND the identity controls the Cobblr header would
  // have had — who you are, Log out (everyone), and a Dashboard hop for
  // dual-access (owner/admin) users. App-only users just get Exit + Log
  // out; the standalone look never strands anyone without a way out.
  if (theme) {
    const isAdmin = caps?.all === true;
    const ff = fontFaceCss(theme);
    return createPortal(
      <OverlayLayer className="z-50 overflow-y-auto" style={themeWrapperStyle(theme)}>
        {ff && <style>{ff}</style>}
        <div className="min-h-full max-w-3xl mx-auto px-5 py-7 sm:py-9 space-y-6">
          <div className="flex items-start justify-between gap-4 border-b pb-3" style={{ borderColor: "var(--app-border)" }}>
            <div className="min-w-0 flex items-center gap-3">
              {theme.logo && (
                // EXTERNAL-IMAGE-OK: an app theme assetRef (data: URL or hosted URL).
                <img src={theme.logo} alt="" className="w-9 h-9 rounded object-contain shrink-0" />
              )}
              <div className="min-w-0">
                <h1 className="text-2xl font-bold truncate leading-tight" style={textStyle(theme)}>
                  {app.data.name}
                </h1>
                {tabsEl}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0 text-xs" style={mutedStyle(theme)}>
              {user?.display_name && <span className="hidden sm:inline">{user.display_name}</span>}
              <AppSwitcher slug={slug} currentSlug={appSlug} theme={theme} />
              {isAdmin && (
                <Link to="/" className="inline-flex items-center gap-1 hover:opacity-80 transition" aria-label="Dashboard" title="Dashboard: switch to the admin view">
                  <LayoutDashboard size={13} /> <span className="hidden sm:inline">Dashboard</span>
                </Link>
              )}
              <Link to={`/portal/${slug}`} className="inline-flex items-center gap-1 hover:opacity-80 transition" title="Back to the portal">
                <ArrowLeft size={13} /> Exit
              </Link>
              <button type="button" onClick={logout} className="inline-flex items-center gap-1 hover:opacity-80 transition" aria-label="Log out" title="Log out">
                <LogOut size={13} /> <span className="hidden sm:inline">Log out</span>
              </button>
            </div>
          </div>
          {blocksEl}
        </div>
      </OverlayLayer>,
      document.body,
    );
  }

  // ── Unthemed → renders inside the Cobblr portal shell, as before ──
  return (
    <div className="space-y-5">
      <Link
        to={`/portal/${slug}?all=1`}
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
        data-testid="app-back"
      >
        <ArrowLeft size={12} /> All apps
      </Link>

      <div className="border-b border-line dark:border-slate-700 pb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-content dark:text-mortar-100">
            {app.data.name}
          </h1>
          {tabsEl}
        </div>
        <div className="text-xs text-muted dark:text-slate-400 shrink-0 pt-1">
          <AppSwitcher slug={slug} currentSlug={appSlug} theme={null} />
        </div>
      </div>

      {blocksEl}
    </div>
  );
}

/** In-app switcher (worker-navigation-and-identity.md, Phase 2): flip to
 *  another app you can open without bouncing to the portal. Renders only
 *  when there's somewhere to go (≥1 OTHER openable app). The portal stays
 *  reachable as the fallback via "All apps" (?all=1, which suppresses the
 *  auto-land). Styles to the app's theme when one is set. */
function AppSwitcher({ slug, currentSlug, theme }: { slug: string; currentSlug: string; theme?: AppTheme | null }) {
  const [open, setOpen] = useState(false);
  const apps = useQuery({ queryKey: ["portal-apps", slug], queryFn: () => api.listApps(slug) });
  const others = (apps.data?.items ?? []).filter((a) => a.slug !== currentSlug);
  if (others.length === 0) return null;
  const menuStyle: React.CSSProperties | undefined = theme
    ? { background: "var(--app-surface)", borderColor: "var(--app-border)", color: "var(--app-text)", borderRadius: "var(--app-radius)" }
    : undefined;
  const menuClass = theme
    ? "absolute right-0 mt-1 z-10 min-w-[11rem] border py-1 text-sm shadow-lg"
    : "absolute right-0 mt-1 z-10 min-w-[11rem] rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 py-1 text-sm shadow-lg";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 hover:opacity-80 transition"
        style={mutedStyle(theme)}
        aria-label="Apps"
        title="Apps: switch app"
      >
        <LayoutGrid size={13} /> <span className="hidden sm:inline">Apps</span> <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <BackdropLayer className="z-0" onClick={() => setOpen(false)} />
          <div className={menuClass} style={menuStyle}>
            {others.map((a) => (
              <Link
                key={a.slug}
                to={`/portal/${slug}/app/${a.slug}`}
                onClick={() => setOpen(false)}
                className="block px-3 py-1.5 hover:opacity-80 truncate"
              >
                {a.name}
              </Link>
            ))}
            <Link
              to={`/portal/${slug}?all=1`}
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 hover:opacity-80 border-t"
              style={{ ...mutedStyle(theme), borderColor: theme ? "var(--app-border)" : undefined }}
            >
              All apps…
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function BlockRenderer({
  slug,
  appSlug,
  block,
  caps,
  theme,
}: {
  slug: string;
  appSlug: string;
  block: AppBlock;
  caps?: Caps;
  theme?: AppTheme | null;
}) {
  switch (block.type) {
    case "view":
      return (
        <ViewBlock
          slug={slug}
          appSlug={appSlug}
          viewId={block.view_id}
          title={block.title}
          theme={theme}
        />
      );
    case "stat":
      return (
        <StatBlock
          slug={slug}
          viewId={block.view_id}
          agg={block.agg}
          field={block.field}
          times={block.times}
          label={block.label}
          theme={theme}
        />
      );
    case "markdown":
      return (
        <div
          className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5"
          style={cardStyle(theme)}
        >
          <div
            className="prose prose-sm dark:prose-invert max-w-none text-content dark:text-mortar-100"
            style={proseStyle(theme)}
          >
            <MarkdownText>{block.body}</MarkdownText>
          </div>
        </div>
      );
    case "form":
      return <FormBlock slug={slug} kind={block.kind} mode={block.mode} only={block.fields} caps={caps} theme={theme} />;
    case "action":
      return (
        <ActionBlock
          slug={slug}
          actionId={block.action_id}
          label={block.label}
          kind={block.kind}
          caps={caps}
          theme={theme}
        />
      );
    case "record":
      return <RecordView slug={slug} appSlug={appSlug} kind={block.kind} id={block.id_from} />;
    case "scan":
      return <ScanBlock slug={slug} theme={theme} />;
    case "custom":
      return <CustomBlock slug={slug} appSlug={appSlug} html={block.html} height={block.height} theme={theme} />;
    default:
      return null;
  }
}

function ViewBlock({
  slug,
  appSlug,
  viewId,
  title,
  theme,
}: {
  slug: string;
  appSlug: string;
  viewId: string;
  title?: string;
  theme?: AppTheme | null;
}) {
  // A block knows its view, not the view's kind (null): any action re-reads
  // it. Every record, and the rest offered when the view is huge: a hard 100
  // cut the list off with nothing to say so.
  const view = useViewData(slug, viewId, null, { enabled: !!viewId });
  return (
    <div className="space-y-2">
      {title && (
        <h2 className="text-sm font-medium text-content dark:text-mortar-200" style={textStyle(theme)}>{title}</h2>
      )}
      {view.isLoading && <div className="text-xs text-faint italic">Loading…</div>}
      {!view.isLoading && view.items.length === 0 && (
        <div className="text-xs text-faint italic py-4">No items.</div>
      )}
      {view.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {view.items.map((item) => (
            <Link
              key={`${item.kind}:${item.id}`}
              to={`/portal/${slug}/app/${appSlug}/r/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.id)}`}
              className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex items-center gap-3 hover:border-accent dark:hover:border-cobble-600 transition"
              style={cardStyle(theme)}
            >
              <EntityThumb src={item.image_path ?? null} alt={item.title} size={48} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-content dark:text-mortar-100 truncate" style={textStyle(theme)}>
                  {item.title}
                </div>
                {item.subtitle && (
                  <div className="text-[10px] uppercase tracking-widest text-faint truncate" style={mutedStyle(theme)}>
                    {item.subtitle}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
      <ViewMore data={view} />
    </div>
  );
}

function StatBlock({
  slug,
  viewId,
  agg,
  field,
  times,
  label,
  theme,
}: {
  slug: string;
  viewId: string;
  agg: "count" | "sum";
  field?: string;
  times?: string;
  label?: string;
  theme?: AppTheme | null;
}) {
  // Every record: a count is the view's total, never the length of a page
  // (a 500-row page made a count stop at 500), and a sum adds every one.
  const data = useViewData(slug, viewId, null, { enabled: !!viewId });
  const items = data.items;
  let value: number | null = null;
  // Past the server's walk a count may not be known and a sum covers only
  // what arrived: shown with a "+", a floor, never passed off as the figure.
  let floor = !data.complete;
  if (!data.isLoading) {
    if (agg === "count") {
      value = data.total ?? items.length;
      floor = data.total === null;
    } else {
      value = statValue(items as Parameters<typeof statValue>[0], { agg, field, times });
    }
  }
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 inline-flex flex-col min-w-[8rem]" style={cardStyle(theme)}>
      <span className="text-2xl font-bold text-content dark:text-mortar-100 tabular-nums" style={accentStyle(theme)}>
        {value === null ? "…" : `${value.toLocaleString()}${floor ? "+" : ""}`}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-faint mt-0.5" style={mutedStyle(theme)}>
        {label ?? (agg === "count" ? "count" : `sum ${field ?? ""}${times ? ` × ${times}` : ""}`)}
      </span>
    </div>
  );
}

// ── Interactive blocks ───────────────────────────────────────────

/** Create-a-record. Reuses the per-kind portal create dialog (same
 *  registry as PortalViewPage). Hidden unless the member holds the
 *  kind's create capability — the server enforces it regardless. */
function FormBlock({
  slug,
  kind,
  mode,
  only,
  caps,
  theme,
}: {
  slug: string;
  kind: string;
  mode: "create" | "edit";
  only?: string[];
  caps?: Caps;
  theme?: AppTheme | null;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const createCap = createCapabilityForKind(kind) ?? undefined;
  if (mode === "edit") return <AppEditForm slug={slug} kind={kind} only={only} theme={theme} />;
  const label = kind.split(":")[1] ?? kind;
  // A create the member may not do yet is offered as an ask, in the block's
  // place, rather than the block vanishing (#3073).
  if (!canDo(caps, createCap)) {
    return createCap && caps ? (
      <AskForItButton slug={slug} remedies={[{ kind: "capability", key: createCap }]} doing="Adding here" subject={`Add ${withArticle(label)}`} label={`Ask to add ${withArticle(label)}`} />
    ) : null;
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition"
        style={btnStyle(theme)}
      >
        <Plus size={14} /> New {label}
      </button>
      {open && kind === "inventory:part" && (
        <InventoryProvider orgSlug={slug} getToken={getToken}>
          <NewPartDialog
            onClose={() => setOpen(false)}
            onCreated={() => {
              setOpen(false);
              void qc.invalidateQueries({ queryKey: ["app-view-data", slug] });
              void qc.invalidateQueries({ queryKey: ["app-stat-data", slug] });
            }}
          />
        </InventoryProvider>
      )}
    </div>
  );
}

/** A capability-gated button that invokes a platform action. Standalone
 *  (no record) — for workspace-level actions; per-record actions live
 *  on the record view's EntityActionsBar. Hidden unless the member
 *  holds the capability; the server enforces it on invoke too. */
function ActionBlock({
  slug,
  actionId,
  label,
  kind,
  caps,
  theme,
}: {
  slug: string;
  actionId: string;
  label?: string;
  kind?: string;
  caps?: Caps;
  theme?: AppTheme | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  // Through the one door (platform-web run-action), so the blocks on this
  // page re-read when the action is done.
  // PRESS-ARGS: the press below asks askBeforePress's questions itself before it runs.
  const runAction = useRunAction();
  // The action's arguments, so one it requires is asked for before it runs
  // rather than refused by the door (#3865).
  const { data: listed } = useQuery({
    queryKey: ["platform-actions", slug, kind ?? ""],
    queryFn: () => api.listActions(slug, kind!),
    enabled: !!kind,
    staleTime: 60_000,
  });
  if (!canDo(caps, actionId)) return null;
  const go = async (args?: Record<string, unknown>) => {
    setBusy(true);
    try {
      // The door offers the action's Undo, saying it ran, when there is one.
      await runAction({ actionId, entityKind: kind ?? "", entityId: "", ...(args && Object.keys(args).length ? { args } : {}) }, { done: `${label ?? actionId} ran.` }).then((r) => {
        if (!undoStepsOf(r.undo).length) toast.success(`${label ?? actionId} ran.`);
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    <AskBeforeRun asking={asking} />
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        const schema = listed?.items.find((a) => a.id === actionId)?.args_schema ?? null;
        const ask = askBeforePress(schema, {});
        if (ask.length === 0) return void go();
        setAsking({
          label: label ?? actionId,
          ask,
          submit: (answers) => {
            setAsking(null);
            void go(pressAnswersToArgs(ask, answers));
          },
          cancel: () => setAsking(null),
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
      style={theme ? { borderColor: "var(--app-border)", color: "var(--app-text)", borderRadius: "var(--app-radius)" } : undefined}
    >
      {label ?? actionId}
    </button>
    </>
  );
}

/** Scan entry point — links to the workspace scanner. */
function ScanBlock({ slug, theme }: { slug: string; theme?: AppTheme | null }) {
  void slug;
  return (
    <Link
      to="/scan"
      className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
      style={btnStyle(theme)}
    >
      <ScanLine size={16} /> Scan an item
    </Link>
  );
}

/** A single record + its capability-gated actions (EntityActionsBar).
 *  The fields shown are already H2-scoped by the resolver, so a worker
 *  sees only what their capabilities allow. Used both as a `record`
 *  block and as the target of a clicked view row (AppRecordPage). */
function RecordView({
  slug,
  appSlug,
  kind,
  id,
}: {
  slug: string;
  appSlug: string;
  kind: string;
  id: string;
}) {
  void appSlug;
  const ent = useQuery({
    queryKey: ["app-record", slug, kind, id],
    queryFn: () => api.lookupEntity(slug, kind, id),
    enabled: !!kind && !!id,
  });
  // Capability-aware actions: hide capability-gated actions the member
  // doesn't hold, so a worker never sees a button that 403s. owner/admin
  // see everything (the server enforces invoke regardless). Non-gated
  // actions always show.
  const caps = useCapabilitiesFor(slug);
  const grantable = useQuery({
    queryKey: ["grantable-actions", slug],
    queryFn: () => api.listGrantableActions(slug),
    enabled: !!slug,
  });
  const isPriv = caps?.all === true;
  const held = new Set(caps?.grants ?? []);
  const excludeActionIds = isPriv
    ? undefined
    : (grantable.data?.items ?? [])
        .map((g) => g.action_id)
        .filter((aid) => !held.has(aid));
  if (ent.isLoading)
    return <div className="text-xs text-faint italic">Loading…</div>;
  if (!ent.data)
    return <div className="text-sm text-muted italic py-4">Record not found.</div>;
  const fields = Object.entries(ent.data.fields ?? {}).filter(
    ([k]) => !k.startsWith("_") && k !== "metadata",
  );
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <EntityThumb src={ent.data.image_path ?? null} alt={ent.data.title} size={64} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-content dark:text-mortar-100">
            {ent.data.title}
          </h2>
          {ent.data.subtitle && (
            <div className="text-[10px] uppercase tracking-widest text-faint">
              {ent.data.subtitle}
            </div>
          )}
        </div>
      </div>
      <EntityActionsBar entityKind={kind} entityId={id} excludeActionIds={excludeActionIds} />
      {fields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {fields.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-widest text-faint">
                {k}
              </dt>
              <dd className="text-content dark:text-mortar-100 truncate">
                {v === null || v === undefined || v === "" ? "—" : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// The SDK injected into every Tier-B custom bundle. Every call is a
// postMessage round-trip the App Player mediates with the capability-
// scoped token — the bundle never holds a token nor touches the API
// directly, and the Player + server clamp restrict it to H2-scoped reads
// and capability-gated actions. Surface:
//   cobblr.get(path)                 — raw allowlisted GET
//   cobblr.viewData(viewId,{limit})  — a saved view's rows (H2-scoped) → []
//   cobblr.entity(kind,id)           — one entity (H2-scoped)
//   cobblr.me()                      — { role, grants } for the viewer
//   cobblr.can(actionId)             — bool: may the viewer run this action
//   cobblr.invoke(id,{entityKind,entityId,args,photo}) / cobblr.action(…) — a write;
//                                    `photo` (an image Blob) travels with it as the action's document
//   cobblr.mount(el, loader, render) — loading/error boilerplate, done once
const SDK_SCRIPT = `<script>(function(){
var pending={},seq=0;
window.addEventListener("message",function(e){var m=e.data;if(!m||m.type!=="cobblr:result")return;var p=pending[m.id];if(!p)return;delete pending[m.id];m.ok?p.resolve(m.data):p.reject(new Error(m.error||"request failed"));});
function send(type,payload){return new Promise(function(res,rej){var id=++seq;pending[id]={resolve:res,reject:rej};var msg={type:type,id:id};if(payload)for(var k in payload)msg[k]=payload[k];parent.postMessage(msg,"*");});}
function fetchPath(path){return send("cobblr:fetch",{path:path});}
function invoke(actionId,opts){opts=opts||{};return send("cobblr:invoke",{actionId:actionId,entityKind:opts.entityKind||"",entityId:opts.entityId||"",args:opts.args||null,photo:opts.photo||null,photoName:opts.photoName||null});}
function qs(o){if(!o)return"";var s=[];for(var k in o){if(o[k]!=null)s.push(encodeURIComponent(k)+"="+encodeURIComponent(o[k]));}return s.length?"?"+s.join("&"):"";}
window.cobblr={
get:fetchPath,
viewData:function(viewId,opts){return fetchPath("/modules/core-views/views/"+encodeURIComponent(viewId)+"/data"+qs(opts)).then(function(r){return (r&&r.items)||[];});},
entity:function(kind,id){return fetchPath("/entities/"+encodeURIComponent(kind)+"/"+encodeURIComponent(id));},
me:function(){return fetchPath("/me/capabilities");},
can:function(actionId){return window.cobblr.me().then(function(c){return !!c&&(c.all===true||((c.grants||[]).indexOf(actionId)>=0));});},
invoke:invoke,
action:invoke,
image:function(path){if(!path)return Promise.resolve(null);return send("cobblr:image",{path:path}).then(function(r){return (r&&r.dataUrl)||null;}).catch(function(){return null;});},
appLoad:function(key){return send("cobblr:appdata",{op:"load",key:key}).then(function(r){return r?r.value:null;});},
appSave:function(key,value,options){var payload={op:"save",key:key,value:value};if(options&&Object.prototype.hasOwnProperty.call(options,"opened"))payload.opened=options.opened;return send("cobblr:appdata",payload);},
mount:function(target,loader,render){var el=typeof target==="string"?document.querySelector(target):target;if(!el)return Promise.resolve();el.textContent="Loading\\u2026";return Promise.resolve().then(loader).then(function(data){el.innerHTML="";render(el,data);}).catch(function(err){el.textContent="\\u26a0 "+((err&&err.message)||err);});}
};
})();</script>`;

/** Tier B — a custom, author/AI-written frontend bundle rendered in a
 *  SANDBOXED iframe (opaque origin: it can't read the parent's session
 *  token or storage). It never gets a token: it requests reads via
 *  postMessage, and this Player mediates them with a short-lived,
 *  capability-scoped token — GET-only, scoped to this org's API. So the
 *  untrusted code can't steal the session, can't write, can't leave the
 *  org, and can't see anything the member's capabilities + H2 disallow. */
// Exported for the app editor's live preview (B3): the SAME sandbox +
// mediated bridge the player uses, so the preview IS the real thing, not a
// lookalike. Token mints once per mount — the editor keys remounts off a
// refresh button rather than every keystroke.
export function CustomBlock({
  slug,
  appSlug,
  html,
  height,
  theme,
}: {
  slug: string;
  appSlug: string;
  html: string;
  height?: number;
  theme?: AppTheme | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  // A token the app could not get is said, never an endless Loading: a guest's
  // app sat there behind a sheet about something they had not done (#6044).
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStartError(null);
    api
      .mintAppToken(slug, appSlug)
      .then((r) => {
        if (!alive) return;
        tokenRef.current = r.token;
        setReady(true); // only render the iframe once the token's in hand
      })
      .catch((e: unknown) => {
        if (alive) setStartError(e instanceof Error ? e.message : "This app could not start.");
      });
    return () => { alive = false; };
  }, [slug, appSlug]);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const ifr = iframeRef.current;
      if (!ifr || e.source !== ifr.contentWindow) return; // only our iframe
      const m = e.data as {
        type?: string;
        id?: number;
        path?: string;
        actionId?: string;
        entityKind?: string;
        entityId?: string;
        args?: Record<string, unknown>;
        photo?: unknown;
        photoName?: unknown;
        op?: string;
        key?: string;
        value?: unknown;
        opened?: unknown;
      };
      const KNOWN = ["cobblr:fetch", "cobblr:invoke", "cobblr:image", "cobblr:appdata"];
      if (!m || !m.type || !KNOWN.includes(m.type)) return;
      const reply = (payload: Record<string, unknown>) =>
        ifr.contentWindow?.postMessage({ type: "cobblr:result", id: m.id, ...payload }, "*");
      const token = tokenRef.current;
      void (async () => {
        if (!token) {
          reply({ ok: false, error: "no token" });
          return;
        }
        try {
          if (m.type === "cobblr:fetch") {
            // READS — the bundle sends an ORG-RELATIVE path; we force the
            // org prefix (can't leave the workspace) AND restrict to
            // H2-SCOPED surfaces only (saved-view data + the entity
            // resolver). Raw module APIs aren't field-scoped, so they're
            // blocked — custom code can only read what the member may
            // see (parts, not prices), as the member, GET-only.
            const rel = m.path ?? "";
            const allowed =
              rel.startsWith("/modules/core-views/views") ||
              rel.startsWith("/entities/") ||
              rel.startsWith("/entity-kinds") ||
              rel === "/me/capabilities";
            if (typeof rel !== "string" || !rel.startsWith("/") || rel.includes("..") || !allowed) {
              reply({ ok: false, error: "request not permitted" });
              return;
            }
            const res = await fetch(`/api/v1/orgs/${slug}${rel}`, {
              headers: { authorization: `Bearer ${token}` },
            });
            const data = await res.json().catch(() => null);
            reply({ ok: res.ok, data, error: res.ok ? undefined : "request failed" });
          } else if (m.type === "cobblr:image") {
            // IMAGE READS — an entity's `image_path` (core-files raw) fetched
            // with the scoped token and returned as a data URL, so a sandboxed
            // app (opaque origin, no token) can render workspace photos. Still
            // member-scoped + read-only; only the core-files raw path is
            // permitted. We normalise off any absolute prefix the entity
            // payload carries, then require it under /modules/core-files/files.
            let rel = (m.path ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1\/orgs\/[^/]+/, "");
            if (rel.startsWith("/files/")) rel = "/modules/core-files" + rel;
            if (!rel.startsWith("/modules/core-files/files/") || rel.includes("..")) {
              reply({ ok: false, error: "image not permitted" });
              return;
            }
            const res = await fetch(`/api/v1/orgs/${slug}${rel}`, { headers: { authorization: `Bearer ${token}` } });
            if (!res.ok) { reply({ ok: false, error: "image fetch failed" }); return; }
            const blob = await res.blob();
            if (blob.size > 8_000_000 || !/^image\//.test(blob.type)) { reply({ ok: false, error: "not an image" }); return; }
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result));
              fr.onerror = () => reject(new Error("read failed"));
              fr.readAsDataURL(blob);
            });
            reply({ ok: true, data: { dataUrl } });
          } else if (m.type === "cobblr:appdata") {
            // APP SCRATCHPAD — the app's OWN key/value bag (e.g. saved looks),
            // gated server-side by canOpen(app). Never touches real entities.
            const key = encodeURIComponent(String(m.key ?? ""));
            if (m.op === "save") {
              const res = await fetch(`/api/v1/orgs/${slug}/modules/core-apps/apps/${appSlug}/data/${key}`, {
                method: "PUT",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ value: m.value ?? null, ...(Object.hasOwn(m, "opened") ? { opened: m.opened } : {}) }),
              });
              const data = await res.json().catch(() => null);
              reply({ ok: res.ok, data, error: res.ok ? undefined : data?.error?.message ?? "Could not save app data. Try again." });
            } else {
              const res = await fetch(`/api/v1/orgs/${slug}/modules/core-apps/apps/${appSlug}/data/${key}`, {
                headers: { authorization: `Bearer ${token}` },
              });
              const data = await res.json().catch(() => null);
              reply({ ok: res.ok, data, error: res.ok ? undefined : "load failed" });
            }
          } else {
            // WRITES — routed through the ONE capability-gated action
            // endpoint. The server's requireCapability(actionId) enforces
            // it as the member, so custom code can only run actions the
            // member is actually granted. No other write path is exposed
            // to the bundle.
            if (typeof m.actionId !== "string" || !m.actionId) {
              reply({ ok: false, error: "actionId required" });
              return;
            }
            const request = appInvokeRequest(
              { actionId: m.actionId, entityKind: m.entityKind ?? "", entityId: m.entityId ?? "", args: m.args ?? undefined },
              m.photo,
              m.photoName,
            );
            if ("error" in request) {
              reply({ ok: false, error: request.error });
              return;
            }
            const url = `/api/v1/orgs/${slug}/actions/invoke`;
            const res = "form" in request
              ? await sendUpload(url, request.form, { token })
              : await fetch(url, {
                  method: "POST",
                  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                  body: request.json,
                });
            const data = (await res.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            reply({ ok: res.ok, data, error: res.ok ? undefined : (data?.error?.message ?? "action failed") });
          }
        } catch {
          reply({ ok: false, error: "request failed" });
        }
      })();
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [slug, appSlug]);

  // SDK first so `cobblr.get` is defined before the author's scripts run.
  // In a themed app, seed the sandbox body with the app's bg + text +
  // font so a custom block coheres by default (no white card, readable
  // text) — the author can still override everything.
  const bodyBg = theme ? (theme.bg ?? "#11223a") : "#ffffff";
  const bodyText = theme ? (theme.text ?? "#f3f6fb") : "#334155";
  const bodyFont = theme && customFontUrl(theme)
    ? `'${CUSTOM_FONT_FAMILY}', system-ui, sans-serif`
    : theme?.font
      ? FONT_STACKS[theme.font]
      : "system-ui,-apple-system,sans-serif";
  const fontFace = fontFaceCss(theme) ?? "";
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${fontFace}body{font-family:${bodyFont};margin:0;padding:14px;color:${bodyText};background:${bodyBg};font-size:14px}</style>${SDK_SCRIPT}</head><body>${html}</body></html>`;
  // FROM A URL, NOT srcdoc (#3300). A srcdoc document inherits this page's
  // Content-Security-Policy, so with `script-src 'self'` enforced the SDK and
  // the author's scripts are both refused and every custom block goes blank.
  // The api hands back a one-shot URL whose RESPONSE carries a sandboxed
  // policy that permits inline script inside that document and nothing else.
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState(false);
  useEffect(() => {
    let alive = true;
    setFrameError(false);
    setFrameUrl(null);
    frameDocUrl(srcDoc, "app-block")
      .then((u) => alive && setFrameUrl(u))
      .catch(() => alive && setFrameError(true));
    return () => {
      alive = false;
    };
  }, [srcDoc]);
  const frameClass = theme ? "w-full border" : "w-full rounded-xl border border-line dark:border-slate-700 bg-surface";
  const frameStyle: React.CSSProperties = theme
    ? { height: `${height ?? 360}px`, background: "var(--app-bg)", borderColor: "var(--app-border)", borderRadius: "var(--app-radius)" }
    : { height: `${height ?? 360}px` };
  if (startError)
    return (
      <div role="alert" className={frameClass + " flex items-center justify-center p-4 text-center text-sm text-muted"} style={frameStyle} data-testid="app-start-error">
        This app could not start: {startError}
      </div>
    );
  if (!ready || (!frameUrl && !frameError))
    return (
      <div className={frameClass + " flex items-center justify-center text-xs text-faint italic"} style={frameStyle}>
        Loading…
      </div>
    );
  if (frameError || !frameUrl)
    return (
      <div className={frameClass + " flex items-center justify-center text-xs text-faint italic"} style={frameStyle}>
        This block could not be prepared.
      </div>
    );
  return (
    <iframe
      ref={iframeRef}
      // Kept alongside the response's own `sandbox` policy: two ways of saying
      // opaque origin, so a browser honouring either one is safe.
      sandbox="allow-scripts"
      src={frameUrl}
      title="custom app"
      className={frameClass}
      style={frameStyle}
    />
  );
}

/** Record route within an app: /portal/:slug/app/:appSlug/r/:kind/:id.
 *  Where a clicked view row lands — the record + its actions. */
export function AppRecordPage() {
  const { slug, appSlug, kind, id } = useParams<{
    slug: string;
    appSlug: string;
    kind: string;
    id: string;
  }>();
  usePageTitle("Record");
  if (!slug || !appSlug || !kind || !id) return null;
  return (
    <div className="space-y-5">
      <Link
        to={`/portal/${slug}/app/${appSlug}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ArrowLeft size={12} /> back
      </Link>
      <RecordView
        slug={slug}
        appSlug={appSlug}
        kind={decodeURIComponent(kind)}
        id={decodeURIComponent(id)}
      />
    </div>
  );
}
