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
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, ScanLine } from "lucide-react";
import {
  EntityActionsBar,
  EntityThumb,
  usePageTitle,
  useToast,
} from "@cobblr/platform-web";
import { NewPartDialog, InventoryProvider } from "@cobblr/inventory/ui";
import { api, getToken, type AppBlock } from "../lib/api";

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
    return <div className="text-xs text-slate-400 italic p-6">Loading…</div>;
  if (app.error || !app.data) {
    return (
      <div className="space-y-4">
        <Link
          to={`/portal/${slug}`}
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-cobble-600"
        >
          <ArrowLeft size={12} /> back
        </Link>
        <div className="text-sm text-slate-500 italic py-8 text-center">
          This app isn't available to you.
        </div>
      </div>
    );
  }

  const pages = app.data.pages ?? [];
  const page = pages[pageIdx] ?? pages[0];

  return (
    <div className="space-y-5">
      <Link
        to={`/portal/${slug}`}
        className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-cobble-600"
      >
        <ArrowLeft size={12} /> back
      </Link>

      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="text-xl font-semibold text-slate-700 dark:text-mortar-100">
          {app.data.name}
        </h1>
        {pages.length > 1 && (
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
                    : "text-slate-500 dark:text-slate-400 hover:bg-mortar-50 dark:hover:bg-slate-800")
                }
              >
                {p.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {!page || page.blocks.length === 0 ? (
        <div className="text-xs text-slate-400 italic py-8 text-center">
          This page has no blocks yet.
        </div>
      ) : (
        <div className="space-y-5">
          {page.blocks.map((block, i) => (
            <BlockRenderer
              key={i}
              slug={slug}
              appSlug={appSlug}
              block={block}
              caps={caps.data}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockRenderer({
  slug,
  appSlug,
  block,
  caps,
}: {
  slug: string;
  appSlug: string;
  block: AppBlock;
  caps?: Caps;
}) {
  switch (block.type) {
    case "view":
      return (
        <ViewBlock
          slug={slug}
          appSlug={appSlug}
          viewId={block.view_id}
          title={block.title}
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
        />
      );
    case "markdown":
      return (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 text-slate-700 dark:text-mortar-100 text-sm whitespace-pre-wrap">
          {block.body}
        </div>
      );
    case "form":
      return <FormBlock slug={slug} kind={block.kind} mode={block.mode} caps={caps} />;
    case "action":
      return (
        <ActionBlock
          slug={slug}
          actionId={block.action_id}
          label={block.label}
          kind={block.kind}
          caps={caps}
        />
      );
    case "record":
      return <RecordView slug={slug} appSlug={appSlug} kind={block.kind} id={block.id_from} />;
    case "scan":
      return <ScanBlock slug={slug} />;
    case "custom":
      return <CustomBlock slug={slug} appSlug={appSlug} html={block.html} height={block.height} />;
    default:
      return null;
  }
}

function ViewBlock({
  slug,
  appSlug,
  viewId,
  title,
}: {
  slug: string;
  appSlug: string;
  viewId: string;
  title?: string;
}) {
  const data = useQuery({
    queryKey: ["app-view-data", slug, viewId],
    queryFn: () => api.viewData(slug, viewId, { limit: 100 }),
    enabled: !!viewId,
  });
  return (
    <div className="space-y-2">
      {title && (
        <h2 className="text-sm font-medium text-slate-600 dark:text-mortar-200">{title}</h2>
      )}
      {data.isLoading && <div className="text-xs text-slate-400 italic">Loading…</div>}
      {data.data && data.data.items.length === 0 && (
        <div className="text-xs text-slate-400 italic py-4">No items.</div>
      )}
      {data.data && data.data.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.data.items.map((item) => (
            <Link
              key={`${item.kind}:${item.id}`}
              to={`/portal/${slug}/app/${appSlug}/r/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.id)}`}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex items-center gap-3 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
            >
              <EntityThumb src={item.image_path ?? null} alt={item.title} size={48} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-700 dark:text-mortar-100 truncate">
                  {item.title}
                </div>
                {item.subtitle && (
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 truncate">
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
}: {
  slug: string;
  viewId: string;
  agg: "count" | "sum";
  field?: string;
  label?: string;
}) {
  const data = useQuery({
    queryKey: ["app-stat-data", slug, viewId, agg, field],
    queryFn: () => api.viewData(slug, viewId, { limit: 1000 }),
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
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 inline-flex flex-col min-w-[8rem]">
      <span className="text-2xl font-bold text-slate-700 dark:text-mortar-100 tabular-nums">
        {value === null ? "…" : value.toLocaleString()}
      </span>
      <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
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
}: {
  slug: string;
  kind: string;
  mode: "create" | "edit";
  caps?: Caps;
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
}: {
  slug: string;
  actionId: string;
  label?: string;
  kind?: string;
  caps?: Caps;
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
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-mortar-100 hover:bg-mortar-50 dark:hover:bg-slate-800 text-sm font-medium px-3 py-1.5 transition disabled:opacity-50"
    >
      {label ?? actionId}
    </button>
  );
}

/** Scan entry point — links to the workspace scanner. */
function ScanBlock({ slug }: { slug: string }) {
  void slug;
  return (
    <Link
      to="/scan"
      className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-1.5 transition"
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
    return <div className="text-xs text-slate-400 italic">Loading…</div>;
  if (!ent.data)
    return <div className="text-sm text-slate-500 italic py-4">Record not found.</div>;
  const fields = Object.entries(ent.data.fields ?? {}).filter(
    ([k]) => !k.startsWith("_") && k !== "metadata",
  );
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <EntityThumb src={ent.data.image_path ?? null} alt={ent.data.title} size={64} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-700 dark:text-mortar-100">
            {ent.data.title}
          </h2>
          {ent.data.subtitle && (
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
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
              <dt className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                {k}
              </dt>
              <dd className="text-slate-700 dark:text-mortar-100 truncate">
                {v === null || v === undefined || v === "" ? "—" : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// Tiny SDK injected into every custom bundle: `cobblr.get(path)` does a
// postMessage round-trip to the App Player (the parent), which mediates
// the read. The bundle never holds a token nor touches the API directly.
const SDK_SCRIPT = `<script>(function(){var pending={},seq=0;window.addEventListener("message",function(e){var m=e.data;if(!m||m.type!=="cobblr:result")return;var p=pending[m.id];if(!p)return;delete pending[m.id];m.ok?p.resolve(m.data):p.reject(new Error(m.error||"request failed"));});window.cobblr={get:function(path){return new Promise(function(res,rej){var id=++seq;pending[id]={resolve:res,reject:rej};parent.postMessage({type:"cobblr:fetch",id:id,path:path},"*");});},invoke:function(actionId,opts){opts=opts||{};return new Promise(function(res,rej){var id=++seq;pending[id]={resolve:res,reject:rej};parent.postMessage({type:"cobblr:invoke",id:id,actionId:actionId,entityKind:opts.entityKind||"",entityId:opts.entityId||"",args:opts.args||null},"*");});}};})();</script>`;

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
}: {
  slug: string;
  appSlug: string;
  html: string;
  height?: number;
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
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:14px;color:#334155;font-size:14px}</style>${SDK_SCRIPT}</head><body>${html}</body></html>`;
  if (!ready)
    return (
      <div
        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white flex items-center justify-center text-xs text-slate-400 italic"
        style={{ height: `${height ?? 360}px` }}
      >
        Loading…
      </div>
    );
  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title="custom app"
      className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white"
      style={{ height: `${height ?? 360}px` }}
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
        className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-cobble-600"
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
