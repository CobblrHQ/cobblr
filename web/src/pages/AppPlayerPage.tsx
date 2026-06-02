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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ScanLine, LogOut, LayoutDashboard, LayoutGrid, ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useAuth } from "../auth/AuthContext";
import {
  EntityActionsBar,
  EntityThumb,
  usePageTitle,
  useToast,
} from "@cobblr/platform-web";
import { NewPartDialog, InventoryProvider } from "@cobblr/inventory/ui";
import { api, getToken, type AppBlock, type AppTheme } from "../lib/api";
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

interface Caps {
  role: string;
  grants: string[];
}
/** Can the viewer perform an action? owner/admin always; else an
 *  explicit grant. Mirrors the server's requireCapability so the
 *  worker app only shows affordances the member can actually use. */
function canDo(caps: Caps | undefined, actionId: string | undefined): boolean {
  if (!actionId) return false;
  if (!caps) return false;
  return caps.role === "owner" || caps.role === "admin" || caps.grants.includes(actionId);
}
/** Per-kind create capability + dialog. Extend as other kinds export a
 *  portal create dialog (same registry shape as PortalViewPage). */
const CREATE_CAPABILITY_BY_KIND: Record<string, string> = {
  "inventory:part": "inventory:create-part",
};

export function AppPlayerPage() {
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>();
  const [pageIdx, setPageIdx] = useState(0);
  const { user, logout } = useAuth();

  const app = useQuery({
    queryKey: ["app", slug, appSlug],
    queryFn: () => api.getApp(slug!, appSlug!),
    enabled: !!slug && !!appSlug,
  });
  const caps = useQuery({
    queryKey: ["my-capabilities", slug],
    queryFn: () => api.getMyCapabilities(slug!),
    enabled: !!slug,
  });
  usePageTitle(app.data?.name ?? "App");

  if (!slug || !appSlug) return null;
  if (app.isLoading)
    return <div className="text-xs text-faint italic p-6">Loading…</div>;
  if (app.error || !app.data) {
    return (
      <div className="space-y-4">
        <Link
          to={`/portal/${slug}`}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-accent"
        >
          <ArrowLeft size={12} /> back
        </Link>
        <div className="text-sm text-muted italic py-8 text-center">
          This app isn't available to you.
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
    <div className="flex flex-wrap gap-1 mt-2">
      {pages.map((p, i) => (
        <button
          key={p.slug}
          type="button"
          onClick={() => setPageIdx(i)}
          className={
            "px-3 py-1 rounded-md text-sm transition " +
            (i === pageIdx
              ? "bg-cobble-600 text-white"
              : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800")
          }
          style={i === pageIdx ? btnStyle(theme) : mutedStyle(theme)}
        >
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
          <BlockRenderer key={i} slug={slug} appSlug={appSlug} block={block} caps={caps.data} theme={theme} />
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
    const isAdmin = caps.data?.role === "owner" || caps.data?.role === "admin";
    const ff = fontFaceCss(theme);
    return createPortal(
      <div className="fixed inset-0 z-50 overflow-y-auto" style={themeWrapperStyle(theme)}>
        {ff && <style>{ff}</style>}
        <div className="min-h-full max-w-3xl mx-auto px-5 py-7 sm:py-9 space-y-6">
          <div className="flex items-start justify-between gap-4 border-b pb-3" style={{ borderColor: "var(--app-border)" }}>
            <div className="min-w-0 flex items-center gap-3">
              {theme.logo && (
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
                <Link to="/" className="inline-flex items-center gap-1 hover:opacity-80 transition" title="Switch to the admin dashboard">
                  <LayoutDashboard size={13} /> <span className="hidden sm:inline">Dashboard</span>
                </Link>
              )}
              <Link to={`/portal/${slug}`} className="inline-flex items-center gap-1 hover:opacity-80 transition" title="Back to the portal">
                <ArrowLeft size={13} /> Exit
              </Link>
              <button type="button" onClick={logout} className="inline-flex items-center gap-1 hover:opacity-80 transition" title="Log out">
                <LogOut size={13} /> <span className="hidden sm:inline">Log out</span>
              </button>
            </div>
          </div>
          {blocksEl}
        </div>
      </div>,
      document.body,
    );
  }

  // ── Unthemed → renders inside the Cobblr portal shell, as before ──
  return (
    <div className="space-y-5">
      <Link
        to={`/portal/${slug}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ArrowLeft size={12} /> back
      </Link>

      <div className="border-b border-line dark:border-slate-700 pb-3 flex items-start justify-between gap-3">
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
        title="Switch app"
      >
        <LayoutGrid size={13} /> <span className="hidden sm:inline">Apps</span> <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-0" onClick={() => setOpen(false)} />
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
            <ReactMarkdown>{block.body}</ReactMarkdown>
          </div>
        </div>
      );
    case "form":
      return <FormBlock slug={slug} kind={block.kind} mode={block.mode} caps={caps} theme={theme} />;
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
  const data = useQuery({
    queryKey: ["app-view-data", slug, viewId],
    queryFn: () => api.viewData(slug, viewId, { limit: 100 }),
    enabled: !!viewId,
  });
  return (
    <div className="space-y-2">
      {title && (
        <h2 className="text-sm font-medium text-content dark:text-mortar-200" style={textStyle(theme)}>{title}</h2>
      )}
      {data.isLoading && <div className="text-xs text-faint italic">Loading…</div>}
      {data.data && data.data.items.length === 0 && (
        <div className="text-xs text-faint italic py-4">No items.</div>
      )}
      {data.data && data.data.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.data.items.map((item) => (
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
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint truncate" style={mutedStyle(theme)}>
                    {item.subtitle}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function StatBlock({
  slug,
  viewId,
  agg,
  field,
  label,
  theme,
}: {
  slug: string;
  viewId: string;
  agg: "count" | "sum";
  field?: string;
  label?: string;
  theme?: AppTheme | null;
}) {
  const data = useQuery({
    queryKey: ["app-stat-data", slug, viewId, agg, field],
    // The views-data endpoint caps limit at 500; asking for more 400s and
    // the stat never resolves (shows "…"). 500 is the practical ceiling.
    queryFn: () => api.viewData(slug, viewId, { limit: 500 }),
    enabled: !!viewId,
  });
  const items = data.data?.items ?? [];
  let value: number | null = null;
  if (data.data) {
    if (agg === "count") value = items.length;
    else if (agg === "sum" && field)
      value = items.reduce((acc, it) => {
        const v = (it.fields as Record<string, unknown> | undefined)?.[field];
        const n = typeof v === "number" ? v : Number(v);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
  }
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 inline-flex flex-col min-w-[8rem]" style={cardStyle(theme)}>
      <span className="text-2xl font-bold text-content dark:text-mortar-100 tabular-nums" style={accentStyle(theme)}>
        {value === null ? "…" : value.toLocaleString()}
      </span>
      <span className="text-[10px] font-mono uppercase tracking-widest text-faint mt-0.5" style={mutedStyle(theme)}>
        {label ?? (agg === "count" ? "count" : `sum ${field ?? ""}`)}
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
  caps,
  theme,
}: {
  slug: string;
  kind: string;
  mode: "create" | "edit";
  caps?: Caps;
  theme?: AppTheme | null;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const createCap = CREATE_CAPABILITY_BY_KIND[kind];
  if (mode !== "create" || !canDo(caps, createCap)) return null;
  const label = kind.split(":")[1] ?? kind;
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
  if (!canDo(caps, actionId)) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.invokeAction(slug, { actionId, entityKind: kind ?? "", entityId: "" });
          toast.success(`${label ?? actionId} ran.`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Action failed.");
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
      style={theme ? { borderColor: "var(--app-border)", color: "var(--app-text)", borderRadius: "var(--app-radius)" } : undefined}
    >
      {label ?? actionId}
    </button>
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
  const caps = useQuery({
    queryKey: ["my-capabilities", slug],
    queryFn: () => api.getMyCapabilities(slug),
    enabled: !!slug,
  });
  const grantable = useQuery({
    queryKey: ["grantable-actions", slug],
    queryFn: () => api.listGrantableActions(slug),
    enabled: !!slug,
  });
  const isPriv = caps.data?.role === "owner" || caps.data?.role === "admin";
  const held = new Set(caps.data?.grants ?? []);
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
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
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
              <dt className="text-[10px] font-mono uppercase tracking-widest text-faint">
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
//   cobblr.invoke(id,{entityKind,entityId,args}) / cobblr.action(…) — a write
//   cobblr.mount(el, loader, render) — loading/error boilerplate, done once
const SDK_SCRIPT = `<script>(function(){
var pending={},seq=0;
window.addEventListener("message",function(e){var m=e.data;if(!m||m.type!=="cobblr:result")return;var p=pending[m.id];if(!p)return;delete pending[m.id];m.ok?p.resolve(m.data):p.reject(new Error(m.error||"request failed"));});
function fetchPath(path){return new Promise(function(res,rej){var id=++seq;pending[id]={resolve:res,reject:rej};parent.postMessage({type:"cobblr:fetch",id:id,path:path},"*");});}
function invoke(actionId,opts){opts=opts||{};return new Promise(function(res,rej){var id=++seq;pending[id]={resolve:res,reject:rej};parent.postMessage({type:"cobblr:invoke",id:id,actionId:actionId,entityKind:opts.entityKind||"",entityId:opts.entityId||"",args:opts.args||null},"*");});}
function qs(o){if(!o)return"";var s=[];for(var k in o){if(o[k]!=null)s.push(encodeURIComponent(k)+"="+encodeURIComponent(o[k]));}return s.length?"?"+s.join("&"):"";}
window.cobblr={
get:fetchPath,
viewData:function(viewId,opts){return fetchPath("/modules/core-views/views/"+encodeURIComponent(viewId)+"/data"+qs(opts)).then(function(r){return (r&&r.items)||[];});},
entity:function(kind,id){return fetchPath("/entities/"+encodeURIComponent(kind)+"/"+encodeURIComponent(id));},
me:function(){return fetchPath("/me/capabilities");},
can:function(actionId){return window.cobblr.me().then(function(c){return !!c&&(c.role==="owner"||c.role==="admin"||((c.grants||[]).indexOf(actionId)>=0));});},
invoke:invoke,
action:invoke,
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
function CustomBlock({
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

  useEffect(() => {
    let alive = true;
    api
      .mintAppToken(slug, appSlug)
      .then((r) => {
        if (!alive) return;
        tokenRef.current = r.token;
        setReady(true); // only render the iframe once the token's in hand
      })
      .catch(() => {});
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
      };
      if (!m || (m.type !== "cobblr:fetch" && m.type !== "cobblr:invoke")) return;
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
            const res = await fetch(`/api/v1/orgs/${slug}/actions/invoke`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({
                actionId: m.actionId,
                entityKind: m.entityKind ?? "",
                entityId: m.entityId ?? "",
                args: m.args ?? undefined,
              }),
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
  }, [slug]);

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
  const frameClass = theme ? "w-full border" : "w-full rounded-xl border border-line dark:border-slate-700 bg-surface";
  const frameStyle: React.CSSProperties = theme
    ? { height: `${height ?? 360}px`, background: "var(--app-bg)", borderColor: "var(--app-border)", borderRadius: "var(--app-radius)" }
    : { height: `${height ?? 360}px` };
  if (!ready)
    return (
      <div className={frameClass + " flex items-center justify-center text-xs text-faint italic"} style={frameStyle}>
        Loading…
      </div>
    );
  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
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
