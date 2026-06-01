// /configuration/apps — author worker apps (H1, Tier A) in the admin
// shell. Structured editor (no freeform canvas): an app is pages →
// blocks, each block bound to an existing view / kind / action /
// capability via dropdowns. Saved apps render in the member portal via
// the App Player. Members only ever see apps + fields their
// capabilities allow — the server enforces it; this page is authoring.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, ArrowUp, ArrowDown, ExternalLink } from "lucide-react";
import { useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ThemeEditor } from "../components/ThemeEditor";
import {
  api,
  type AppBlock,
  type AppPage,
  type WorkspaceApp,
  type WorkspaceAppMeta,
} from "../lib/api";

const BLOCK_TYPES: AppBlock["type"][] = [
  "markdown",
  "view",
  "stat",
  "form",
  "action",
  "record",
  "scan",
  "custom",
];

export function AppsConfigPage() {
  usePageTitle("Apps");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<WorkspaceApp | null>(null);

  const apps = useQuery({
    queryKey: ["config-apps", slug],
    queryFn: () => api.listApps(slug),
    enabled: !!slug,
  });
  const views = useQuery({
    queryKey: ["config-views", slug],
    queryFn: () => api.listSavedViews(slug),
    enabled: !!slug,
  });
  const kinds = useQuery({
    queryKey: ["config-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });
  const grantable = useQuery({
    queryKey: ["config-grantable", slug],
    queryFn: () => api.listGrantableActions(slug),
    enabled: !!slug,
  });

  async function openApp(meta: WorkspaceAppMeta) {
    const full = await api.getApp(slug, meta.slug);
    setEditing(full);
  }
  async function createApp() {
    const name = window.prompt("App name?");
    if (!name) return;
    const appSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      const created = await api.createApp(slug, { slug: appSlug, name, pages: [] });
      await qc.invalidateQueries({ queryKey: ["config-apps", slug] });
      setEditing(created);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create app.");
    }
  }
  async function save() {
    if (!editing) return;
    try {
      await api.updateApp(slug, editing.slug, {
        name: editing.name,
        visible_capability: editing.visible_capability,
        pages: editing.pages,
        theme: editing.theme ?? null,
      });
      await qc.invalidateQueries({ queryKey: ["config-apps", slug] });
      toast.success("App saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    }
  }
  async function remove(meta: WorkspaceAppMeta) {
    const ok = await confirm({ title: `Delete "${meta.name}"?`, message: "This removes the app for everyone.", confirmLabel: "Delete", destructive: true });
    if (!ok) return;
    await api.deleteApp(slug, meta.slug);
    await qc.invalidateQueries({ queryKey: ["config-apps", slug] });
    if (editing?.slug === meta.slug) setEditing(null);
  }

  // ── editor mutation helpers (immutable updates on `editing`) ──
  const setPages = (pages: AppPage[]) => setEditing((a) => (a ? { ...a, pages } : a));
  const setTheme = (patch: Partial<NonNullable<WorkspaceApp["theme"]>> | null) =>
    setEditing((a) => (a ? { ...a, theme: patch === null ? null : { ...(a.theme ?? {}), ...patch } } : a));
  const addPage = () =>
    editing &&
    setPages([...editing.pages, { slug: `page-${editing.pages.length + 1}`, title: "New page", blocks: [] }]);
  const updatePage = (pi: number, patch: Partial<AppPage>) =>
    editing && setPages(editing.pages.map((p, i) => (i === pi ? { ...p, ...patch } : p)));
  const removePage = (pi: number) => editing && setPages(editing.pages.filter((_, i) => i !== pi));
  const addBlock = (pi: number, type: AppBlock["type"]) => {
    if (!editing) return;
    const fresh = defaultBlock(type);
    updatePage(pi, { blocks: [...editing.pages[pi]!.blocks, fresh] });
  };
  const updateBlock = (pi: number, bi: number, block: AppBlock) =>
    editing &&
    updatePage(pi, { blocks: editing.pages[pi]!.blocks.map((b, i) => (i === bi ? block : b)) });
  const removeBlock = (pi: number, bi: number) =>
    editing && updatePage(pi, { blocks: editing.pages[pi]!.blocks.filter((_, i) => i !== bi) });
  const moveBlock = (pi: number, bi: number, dir: -1 | 1) => {
    if (!editing) return;
    const blocks = [...editing.pages[pi]!.blocks];
    const ni = bi + dir;
    if (ni < 0 || ni >= blocks.length) return;
    [blocks[bi], blocks[ni]] = [blocks[ni]!, blocks[bi]!];
    updatePage(pi, { blocks });
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-700 dark:text-mortar-100">Apps</h1>
          <p className="text-xs text-slate-400">
            Structured worker apps for the member portal. Members see only the apps + fields their
            capabilities allow.
          </p>
        </div>
        <button
          type="button"
          onClick={createApp}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5"
        >
          <Plus size={14} /> New app
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* App list */}
        <div className="space-y-2">
          {apps.isLoading && (
            <div className="text-xs text-slate-400 italic p-3">Loading…</div>
          )}
          {apps.isError && !apps.isLoading && (
            <div className="text-xs text-ember-500 italic p-3">
              Couldn't load apps.
            </div>
          )}
          {(apps.data?.items ?? []).map((a) => (
            <div
              key={a.id}
              className={
                "rounded-lg border p-3 flex items-center gap-2 cursor-pointer transition " +
                (editing?.slug === a.slug
                  ? "border-cobble-400 bg-cobble-50/40 dark:bg-cobble-900/20"
                  : "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-cobble-300")
              }
              onClick={() => void openApp(a)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-700 dark:text-mortar-100 truncate">{a.name}</div>
                <div className="text-[10px] font-mono text-slate-400 truncate">
                  {a.visible_capability ?? "any member"}
                </div>
              </div>
              <a
                href={`/portal/${slug}/app/${a.slug}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-slate-300 hover:text-cobble-600 p-1"
                title="Open app in the portal"
              >
                <ExternalLink size={13} />
              </a>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void remove(a); }}
                className="text-slate-300 hover:text-ember-500 p-1"
                title="Delete app"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!apps.isLoading && (apps.data?.items ?? []).length === 0 && (
            <div className="text-xs text-slate-400 italic p-3">No apps yet. Create one.</div>
          )}
        </div>

        {/* Editor */}
        <div className="col-span-2">
          {!editing ? (
            <div className="text-sm text-slate-400 italic p-6 text-center border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
              Select an app to edit, or create one.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="text-lg font-semibold bg-transparent border-b border-slate-200 dark:border-slate-700 focus:outline-none focus:border-cobble-400 text-slate-700 dark:text-mortar-100 flex-1"
                />
                <a
                  href={`/portal/${slug}/app/${editing.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-cobble-300 text-cobble-600 hover:bg-cobble-50 dark:hover:bg-cobble-900/20 text-sm font-medium px-3 py-1.5 whitespace-nowrap"
                  title="Open this app in the portal (new tab)"
                >
                  <ExternalLink size={14} /> Open app
                </a>
              </div>

              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">
                  Visible to
                </span>
                <select
                  value={editing.visible_capability ?? ""}
                  onChange={(e) => setEditing({ ...editing, visible_capability: e.target.value || null })}
                  className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
                >
                  <option value="">Any member</option>
                  {(grantable.data?.items ?? []).map((g) => (
                    <option key={g.action_id} value={g.action_id}>
                      members with: {g.label} ({g.action_id})
                    </option>
                  ))}
                </select>
              </label>

              {/* Look & feel — per-app theme so the members' app can look
                  like the builder's thing, not Cobblr. Shared with the
                  portal launcher's theme editor (components/ThemeEditor). */}
              <ThemeEditor
                theme={editing.theme}
                onChange={setTheme}
                helpText="Restyles the app's content for members. Unset = Cobblr default. Save, then open to preview."
              />

              {editing.pages.map((page, pi) => (
                <div key={pi} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={page.title}
                      onChange={(e) => updatePage(pi, { title: e.target.value })}
                      className="text-sm font-medium bg-transparent border-b border-slate-200 dark:border-slate-700 focus:outline-none flex-1"
                    />
                    <button type="button" onClick={() => removePage(pi)} className="text-slate-300 hover:text-ember-500 p-1">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {page.blocks.map((block, bi) => (
                    <div key={bi} className="rounded border border-slate-100 dark:border-slate-800 bg-mortar-50/40 dark:bg-slate-800/40 p-2 flex items-start gap-2">
                      <div className="flex flex-col gap-0.5 pt-0.5">
                        <button type="button" onClick={() => moveBlock(pi, bi, -1)} className="text-slate-300 hover:text-cobble-500"><ArrowUp size={11} /></button>
                        <button type="button" onClick={() => moveBlock(pi, bi, 1)} className="text-slate-300 hover:text-cobble-500"><ArrowDown size={11} /></button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <BlockEditor
                          block={block}
                          views={views.data?.items ?? []}
                          kinds={(kinds.data?.items ?? []).map((k) => k.id)}
                          onChange={(b) => updateBlock(pi, bi, b)}
                        />
                      </div>
                      <button type="button" onClick={() => removeBlock(pi, bi)} className="text-slate-300 hover:text-ember-500 p-1">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono uppercase text-slate-400">add block:</span>
                    {BLOCK_TYPES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => addBlock(pi, t)}
                        className="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-cobble-600 hover:bg-mortar-50 dark:hover:bg-slate-800"
                      >
                        + {t}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex items-center gap-2">
                <button type="button" onClick={addPage} className="text-xs text-cobble-600 hover:underline inline-flex items-center gap-1">
                  <Plus size={12} /> add page
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => void save()}
                  className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-1.5"
                >
                  Save app
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function defaultBlock(type: AppBlock["type"]): AppBlock {
  switch (type) {
    case "markdown": return { type, body: "Text…" };
    case "view": return { type, view_id: "" };
    case "stat": return { type, view_id: "", agg: "count" };
    case "form": return { type, kind: "", mode: "create" };
    case "action": return { type, action_id: "" };
    case "record": return { type, kind: "", id_from: "route" };
    case "scan": return { type };
    case "custom": return { type, html: "<h3>My custom view</h3>\n<div id=\"out\">loading…</div>\n<script>\n// Reads are GET-only + capability/H2-scoped. Use a saved view's data:\n//   cobblr.get('/modules/core-views/views/<VIEW_ID>/data')\ncobblr.get('/modules/core-views/views').then(function(r){document.getElementById('out').textContent = (r.items||[]).length + ' saved views available';});\n</script>" };
  }
}

function BlockEditor({
  block,
  views,
  kinds,
  onChange,
}: {
  block: AppBlock;
  views: { id: string; name: string; entity_kind: string }[];
  kinds: string[];
  onChange: (b: AppBlock) => void;
}) {
  const labelCls = "text-[10px] font-mono uppercase tracking-widest text-slate-400";
  const inputCls = "w-full px-2 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900";
  const ViewSelect = ({ value, onPick }: { value: string; onPick: (v: string) => void }) => (
    <select value={value} onChange={(e) => onPick(e.target.value)} className={inputCls}>
      <option value="">— pick a view —</option>
      {views.map((v) => (<option key={v.id} value={v.id}>{v.name} ({v.entity_kind})</option>))}
    </select>
  );
  const KindSelect = ({ value, onPick }: { value: string; onPick: (v: string) => void }) => (
    <select value={value} onChange={(e) => onPick(e.target.value)} className={inputCls}>
      <option value="">— pick a kind —</option>
      {kinds.map((k) => (<option key={k} value={k}>{k}</option>))}
    </select>
  );
  return (
    <div className="space-y-1">
      <div className={labelCls}>{block.type}</div>
      {block.type === "markdown" && (
        <textarea value={block.body} onChange={(e) => onChange({ ...block, body: e.target.value })} rows={2} className={inputCls} />
      )}
      {block.type === "view" && (
        <ViewSelect value={block.view_id} onPick={(v) => onChange({ ...block, view_id: v })} />
      )}
      {block.type === "stat" && (
        <div className="flex gap-1">
          <ViewSelect value={block.view_id} onPick={(v) => onChange({ ...block, view_id: v })} />
          <select value={block.agg} onChange={(e) => onChange({ ...block, agg: e.target.value as "count" | "sum" })} className={inputCls + " w-24"}>
            <option value="count">count</option>
            <option value="sum">sum</option>
          </select>
          {block.agg === "sum" && (
            <input value={block.field ?? ""} onChange={(e) => onChange({ ...block, field: e.target.value })} placeholder="field" className={inputCls + " w-28"} />
          )}
        </div>
      )}
      {block.type === "form" && (
        <KindSelect value={block.kind} onPick={(v) => onChange({ ...block, kind: v })} />
      )}
      {block.type === "action" && (
        <input value={block.action_id} onChange={(e) => onChange({ ...block, action_id: e.target.value })} placeholder="action_id (e.g. purchases:receive-order)" className={inputCls} />
      )}
      {block.type === "record" && (
        <KindSelect value={block.kind} onPick={(v) => onChange({ ...block, kind: v })} />
      )}
      {block.type === "scan" && <div className="text-[11px] text-slate-400 italic">scanner link — no config</div>}
      {block.type === "custom" && (
        <div className="space-y-1">
          <div className="text-[10px] text-slate-400">
            Custom HTML/JS — runs sandboxed. Read data with{" "}
            <code className="font-mono">cobblr.get('/modules/…')</code> (org-relative, GET-only,
            capability + H2 scoped).
          </div>
          <textarea
            value={block.html}
            onChange={(e) => onChange({ ...block, html: e.target.value })}
            rows={6}
            className={inputCls + " font-mono text-[11px]"}
          />
        </div>
      )}
    </div>
  );
}
