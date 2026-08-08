// /assets — list + detail modal for the assets module. Same shape
// as MachinesPage. No specialisations yet (no assets:asset Pillar-E
// modules ship), so no lens UI here — but the column rendering is
// already lens-ready: when a future "Vintage Tools" or
// "Collectibles" module contributes field-defs, they'll appear as
// extra columns automatically (no code change here).

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plus, Printer, Search, Sprout, Tag as TagIcon, Trash2, Undo2, Wand2 } from "lucide-react";
import { ApiError, api, type Asset, type OrgModuleListItem, type PlatformFieldDef } from "../lib/api";
import { isShapeValidVin, planVinFill, type VinFill, type VinFillTarget } from "../lib/vin";
import { ModuleInstanceChooser } from "../components/ModuleInstanceChooser";
import { queueLabelsBulk } from "../lib/queue-label";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { CustomFieldsPanel,
  EntityActionsBar,
  Modal,
  useToast,
  useConfirm, usePageTitle } from "@cobblr/platform-web";
import {
  BulkActionBar,
  EntityThumb,
  EntityTile,
  ViewModeToggle,
  useViewMode,
} from "@cobblr/platform-web";
import { EntityAttachments } from "../components/EntityAttachments";
import { LocationPicker } from "../components/LocationPicker";
import { ContentsPanel } from "../components/ContentsPanel";

const ENTITY_KIND = "assets:asset";

export function AssetsPage({
  instance,
  displayName,
  itemNoun,
}: { instance?: string; displayName?: string; itemNoun?: string } = {}) {
  // When `instance` is set we render ONE named collection of assets (e.g.
  // "Vehicles"), reached at the clean /<instance> URL — the SAME rich page as
  // /assets (thumbnails, views, detail/edit), just scoped to the instance's
  // items. No lens/instance-chooser (the instance IS the focus), and detail is
  // local state (no /<instance>/:id route). Mirrors MachinesPage.
  usePageTitle(displayName ?? "Assets");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const lensName = instance ? null : searchParams.get("lens");
  const viewId = searchParams.get("view");
  const noun = itemNoun?.trim() || "asset";
  // On an instance page, fields/views are keyed to the instance ("vehicles:item")
  // rather than the base assets:asset. Mirrors MachinesPage's viewKind.
  const entityKind = instance ? `${instance}:item` : ENTITY_KIND;

  // Detail selection: URL param on /assets, local state (+ deep-link ?asset=id)
  // on an instance page.
  const [localSel, setLocalSel] = useState<string | null>(null);
  const selectedId = instance ? localSel : id ?? null;
  useEffect(() => {
    if (!instance) return;
    const a = searchParams.get("asset");
    if (a && a !== localSel) setLocalSel(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, searchParams]);
  const openDetail = (aid: string) => {
    if (instance) {
      setLocalSel(aid);
      setSearchParams((prev) => { prev.set("asset", aid); return prev; }, { replace: true });
    } else navigate(`/assets/${aid}${searchParams.toString() ? `?${searchParams}` : ""}`);
  };
  const closeDetail = () => {
    if (instance) {
      setLocalSel(null);
      setSearchParams((prev) => { prev.delete("asset"); return prev; }, { replace: true });
    } else navigate(`/assets${searchParams.toString() ? `?${searchParams}` : ""}`);
  };

  const list = useQuery({
    queryKey: ["assets", activeSlug, instance ?? null],
    queryFn: () => api.listAssets(activeSlug, instance),
    enabled: !!activeSlug,
  });
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", activeSlug, entityKind, "effective"],
    queryFn: () => api.listFieldDefs(activeSlug, entityKind, true),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const orgModules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  // Assets instances (Plants / Documents / Warranties…). With no base-table
  // assets, show these as a chooser instead of a bare "nothing here" — the
  // aggregate dashboard tile lands here.
  const assetInstances = useQuery({
    queryKey: ["instances", activeSlug, "assets"],
    queryFn: () => api.listInstances(activeSlug, "assets"),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // Saved views for assets — bundles (Plants, Pets, …) ship pinned
  // ones; the wizard lands here via ?view=. A chip bar switches between them
  // and "All assets". An active view drives the columns (its visible_fields)
  // and grouping (its group_by).
  const savedViews = useQuery({
    queryKey: ["saved-views", activeSlug, entityKind],
    queryFn: () => api.listSavedViews(activeSlug, entityKind),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const views = savedViews.data?.items ?? [];
  const activeView = viewId ? views.find((v) => v.id === viewId) ?? null : null;
  const groupBy = (activeView?.config as { group_by?: string } | undefined)?.group_by;
  const viewFields = (activeView?.config as { visible_fields?: string[] } | undefined)?.visible_fields;
  function selectView(id: string | null) {
    setSearchParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set("view", id);
        else n.delete("view");
        return n;
      },
      { replace: true },
    );
  }

  const lensFieldDefs: PlatformFieldDef[] = (fieldDefs.data?.items ?? []).filter((d) => {
    if (lensName) return d.source_module === lensName;
    return d.source_module !== null;
  });
  // Columns shown after the native ones: an active view picks them by
  // visible_fields (includes bundle fields, which lensFieldDefs would skip);
  // otherwise fall back to the lens behaviour.
  const customCols: PlatformFieldDef[] = viewFields
    ? (fieldDefs.data?.items ?? []).filter((d) => viewFields.includes(d.name))
    : lensFieldDefs;
  const lensModule: OrgModuleListItem | undefined = lensName
    ? orgModules.data?.items.find((m) => m.name === lensName)
    : undefined;

  const allRows = list.data?.items ?? [];
  const rows = lensName
    ? allRows.filter((m) =>
        lensFieldDefs.some((d) => {
          const v = (m.metadata as Record<string, unknown>)[d.name];
          return v !== null && v !== undefined && v !== "";
        }),
      )
    : allRows;

  const [query, setQuery] = useState("");
  const filtered = query
    ? rows.filter((m) =>
        [m.name, m.manufacturer, m.model, m.type, m.short_name]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(query.toLowerCase())),
      )
    : rows;

  const [newOpen, setNewOpen] = useState(false);
  const [viewMode, setViewMode] = useViewMode("assets", "list");
  // Bulk-select state. Only enabled in list view (tile mode keeps
  // click-to-open semantics). Tracks the IDs as a Set so toggle is
  // O(1) and selectAll is one Set replacement.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      // Sequential to keep the API gentle; few-dozen-row selections
      // finish in well under a second even one-at-a-time.
      for (const id of ids) {
        await api.deleteAsset(activeSlug, id, instance);
      }
    },
    onSuccess: () => {
      toast.success(`Deleted ${selected.size} asset${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  function toggleRow(id: string, checked: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (checked) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  function selectAll(checked: boolean) {
    if (checked) setSelected(new Set(filtered.map((r) => r.id)));
    else setSelected(new Set());
  }
  const allChecked = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const openAsset = (aid: string) => openDetail(aid);

  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const bulkTag = useMutation({
    mutationFn: async (tagName: string) => {
      for (const id of Array.from(selected)) {
        await api.attachTag(activeSlug, {
          tag_name: tagName,
          source_module: "assets",
          source_type: "asset",
          source_id: id,
        });
      }
    },
    onSuccess: () => {
      toast.success(`Tagged ${selected.size} asset${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      setBulkTagOpen(false);
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          {displayName ?? "assets"}
        </h1>
        {lensModule && (
          <Link
            to="/assets"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cobble-100 text-accent dark:bg-cobble-700/40 dark:text-cobble-200 text-[10px] font-mono uppercase tracking-widest hover:bg-cobble-200 transition"
            title="Clear lens"
          >
            lens: {lensModule.displayName} ×
          </Link>
        )}
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          {filtered.length} of {allRows.length}
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search…"
            className="input !py-1 !pl-7 !text-xs !w-48"
          />
        </div>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          onClick={() => setNewOpen(true)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <Plus size={14} /> New {noun}
        </button>
      </div>

      {/* Saved-view chips — bundles ship pinned ones; the wizard lands here. */}
      {views.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <AssetViewChip active={!activeView} onClick={() => selectView(null)}>
            All assets
          </AssetViewChip>
          {views.map((v) => (
            <AssetViewChip key={v.id} active={activeView?.id === v.id} onClick={() => selectView(v.id)}>
              {v.name}
            </AssetViewChip>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        // The instance-chooser is a BASE-page affordance ("pick one of your asset
        // tables"); on an instance page we're already inside one, so never show it.
        !instance && allRows.length === 0 && (assetInstances.data?.items.length ?? 0) > 0 ? (
          <ModuleInstanceChooser instances={assetInstances.data!.items} icon={Sprout} noun="asset" />
        ) : (
          <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-12 text-center text-xs text-faint dark:text-slate-500 italic">
            {allRows.length === 0
              ? `No ${noun}s yet. Click + New ${noun} to add one.`
              : activeView
                ? `Nothing in “${activeView.name}” yet — add your first with New asset.`
                : "No matches with the current filters."}
          </div>
        )
      ) : groupBy ? (
        groupItems(filtered, groupBy).map((g) => (
          <div key={g.key} className="space-y-2">
            <h3 className="text-xs font-mono uppercase tracking-widest text-accent">{g.key}</h3>
            {viewMode === "tiles" ? (
              <AssetsTiles rows={g.rows} onOpen={openAsset} />
            ) : (
              <AssetsTable
                instance={instance}
                rows={g.rows}
                customCols={customCols}
                selected={selected}
                allChecked={g.rows.every((r) => selected.has(r.id))}
                onToggle={toggleRow}
                onSelectAll={(checked) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    for (const r of g.rows) checked ? n.add(r.id) : n.delete(r.id);
                    return n;
                  })
                }
                onOpen={openAsset}
              />
            )}
          </div>
        ))
      ) : viewMode === "tiles" ? (
        <AssetsTiles rows={filtered} onOpen={openAsset} />
      ) : (
        <AssetsTable
                instance={instance}
          rows={filtered}
          customCols={customCols}
          selected={selected}
          allChecked={allChecked}
          onToggle={toggleRow}
          onSelectAll={selectAll}
          onOpen={openAsset}
        />
      )}

      <AssetDetailModal
        assetId={selectedId}
        onClose={closeDetail}
        instance={instance}
      />
      <NewAssetModal open={newOpen} onClose={() => setNewOpen(false)} instance={instance} noun={noun} />
      <BulkActionBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <button
              type="button"
              onClick={() => setBulkTagOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            >
              <TagIcon size={12} /> Tag
            </button>
            <button
              type="button"
              onClick={async () => {
                const inputs = Array.from(selected)
                  .map((id) => filtered.find((a) => a.id === id))
                  .filter((a): a is NonNullable<typeof a> => !!a)
                  .map((a) => ({
                    slug: activeSlug,
                    entityKind: "assets:asset",
                    entityId: a.id,
                    description: a.name,
                  }));
                const { ok, fail } = await queueLabelsBulk(inputs);
                if (fail === 0) {
                  toast.success(`Queued ${ok} label${ok === 1 ? "" : "s"}.`);
                } else {
                  toast.error(`Queued ${ok}; ${fail} failed.`);
                }
                setSelected(new Set());
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            >
              <Printer size={12} /> Print labels
            </button>
            <button
              type="button"
              disabled={bulkDelete.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${selected.size} asset${selected.size === 1 ? "" : "s"}?`,
                  message: "This is permanent, the rows will be removed from the workspace.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) bulkDelete.mutate(Array.from(selected));
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 hover:text-ember-700 disabled:opacity-50"
            >
              <Trash2 size={12} /> Delete
            </button>
          </>
        }
      />
      {bulkTagOpen && (
        <BulkTagPromptModal
          count={selected.size}
          busy={bulkTag.isPending}
          onClose={() => setBulkTagOpen(false)}
          onSubmit={(name) => bulkTag.mutate(name)}
        />
      )}
    </div>
  );
}

function AssetViewChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-xs font-medium px-3 py-1 rounded-full border transition " +
        (active
          ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-950/30 text-accent"
          : "border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:border-cobble-300 dark:hover:border-cobble-700")
      }
    >
      {children}
    </button>
  );
}

function AssetsTiles({ rows, onOpen }: { rows: Asset[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {rows.map((a) => (
        <button key={a.id} type="button" onClick={() => onOpen(a.id)} className="text-left">
          <EntityTile
            src={a.image_path}
            title={a.name}
            subtitle={a.manufacturer || a.model || a.short_name || null}
            badge={a.state}
          />
        </button>
      ))}
    </div>
  );
}

function AssetsTable({
  rows,
  customCols,
  selected,
  allChecked,
  onToggle,
  onSelectAll,
  onOpen,
  instance,
}: {
  rows: Asset[];
  customCols: PlatformFieldDef[];
  selected: Set<string>;
  allChecked: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onOpen: (id: string) => void;
  instance?: string;
}) {
  // The column header must respect a bundle relabel too, or the list says
  // "Manufacturer" while the detail page says "Make".
  const fp = useFieldPresentation(instance ? `${instance}:item` : ENTITY_KIND);
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
          <tr>
            <th className="w-8 px-3 py-2">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => onSelectAll(e.target.checked)}
                className="accent-cobble-600"
                aria-label="Select all"
              />
            </th>
            <th className="text-left px-3 py-2">Name</th>
            <th className="text-left px-3 py-2">{fp.label("manufacturer", "Manufacturer")}</th>
            <th className="text-left px-3 py-2">Model</th>
            <th className="text-left px-3 py-2">State</th>
            {customCols.map((d) => (
              <th key={d.id} className="text-left px-3 py-2">{d.display_label}</th>
            ))}
            <th className="text-right px-3 py-2">qty</th>
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-700">
          {rows.map((a) => (
            <tr
              key={a.id}
              onClick={() => onOpen(a.id)}
              className="hover:bg-subtle dark:hover:bg-slate-800/40 transition cursor-pointer"
            >
              <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={(e) => onToggle(a.id, e.target.checked)}
                  className="accent-cobble-600"
                  aria-label={`Select ${a.name}`}
                />
              </td>
              <td className="px-3 py-2 text-content dark:text-mortar-100 font-medium">
                <div className="flex items-center gap-3">
                  <EntityThumb src={a.image_path} alt={a.name} size={56} />
                  <span className="truncate">
                    {a.name}
                    {a.short_name && (
                      <span className="ml-1.5 text-[10px] font-mono text-faint">{a.short_name}</span>
                    )}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2 text-muted dark:text-slate-400">{a.manufacturer || "—"}</td>
              <td className="px-3 py-2 text-muted dark:text-slate-400">{a.model || "—"}</td>
              <td className="px-3 py-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
                  {a.state}
                </span>
              </td>
              {customCols.map((d) => {
                const v = (a.metadata as Record<string, unknown>)[d.name];
                return (
                  <td key={d.id} className="px-3 py-2 text-content dark:text-mortar-200 text-xs">
                    {v === null || v === undefined || v === "" ? "—" : String(v)}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right font-mono text-xs text-muted">{a.quantity}</td>
              <td className="px-2 py-2 text-faint dark:text-slate-600">
                <ChevronRight size={14} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Partition assets by a metadata field (e.g. light), ordered; blanks last. */
function groupItems(items: Asset[], key: string): { key: string; rows: Asset[] }[] {
  const map = new Map<string, Asset[]>();
  for (const a of items) {
    const raw = (a.metadata as Record<string, unknown> | null)?.[key];
    const v = raw == null || String(raw).trim() === "" ? "—" : String(raw).trim();
    if (!map.has(v)) map.set(v, []);
    map.get(v)!.push(a);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, rows]) => ({ key: k, rows }));
}

function BulkTagPromptModal({
  count,
  busy,
  onClose,
  onSubmit,
}: {
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (tagName: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <Modal open onClose={onClose} title={`Tag ${count} item${count === 1 ? "" : "s"}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit(name.trim());
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Tag name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. urgent, summer-2026, archive"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
          <div className="text-[11px] text-faint mt-1">
            Existing tag? It'll be reused. New name? Created on the fly.
          </div>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {busy ? "tagging…" : `Tag ${count}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AssetDetailModal({
  assetId,
  onClose,
  instance,
}: { assetId: string | null; onClose: () => void; instance?: string }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // On an instance page the item lives under /instances/<name>/items and its
  // custom fields are keyed to the instance ("vehicles:item"), NOT the base
  // assets:asset — reading/writing without the instance 404s (the modal then
  // hangs on "loading…"). Thread it through every asset call + the field kind.
  const kind = instance ? `${instance}:item` : ENTITY_KIND;
  const fp = useFieldPresentation(kind);
  const asset = useQuery({
    queryKey: ["asset", activeSlug, instance ?? null, assetId],
    queryFn: () => api.getAsset(activeSlug, assetId!, instance),
    enabled: !!assetId,
    // A server error (404/403/…) is deterministic — don't retry it 3× with
    // backoff before showing the error state; only retry transient network fails.
    retry: (n, e) => !(e instanceof ApiError) && n < 2,
  });
  // Declared/custom fields for this kind — the guarded-auto VIN decode fills
  // whichever of these are named/roled make/model/year/body/fuel (empty ones
  // only). Shared cache with the list page's copy.
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", activeSlug, kind, "effective"],
    queryFn: () => api.listFieldDefs(activeSlug, kind, true),
    enabled: !!assetId,
    staleTime: 60_000,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<Asset>) => api.updateAsset(activeSlug, assetId!, patch, instance),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["asset", activeSlug, instance ?? null, assetId] });
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAsset(activeSlug, assetId!, instance),
    onSuccess: () => {
      toast.success("Asset deleted.");
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const a = asset.data;
  async function handleDelete() {
    if (!a) return;
    const ok = await confirm({
      title: `Delete "${a.name}"?`,
      message: "This can't be undone.",
      confirmLabel: "Delete asset",
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  // The subtitle must honor the same hide overrides the fields do — otherwise a
  // Bookshelf (manufacturer + state hidden) still leaks "Scholastic · Working"
  // in the header even after "Just the essentials".
  const subtitle = a
    ? [
        !fp.hidden("manufacturer") && a.manufacturer ? a.manufacturer : null,
        !fp.hidden("state") && a.state ? a.state : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined
    : undefined;

  return (
    <Modal open={!!assetId} onClose={onClose} title={a?.name ?? (asset.isError ? "Couldn't load" : "loading…")} subtitle={subtitle} size="xl">
      {a ? (
        <div className="space-y-4">
          {/* Wide record layout: the cover large on the LEFT, fields on the
              RIGHT — so an image-bearing record (a book, a wine, a machine)
              uses the width instead of scrolling tall. Stacks on phones. */}
          <div className="grid gap-6 md:grid-cols-[minmax(200px,260px)_1fr]">
            <div className="space-y-3">
              <EntityThumb
                src={a.image_path}
                alt={a.name}
                size={256}
                className="w-full h-auto ring-1 ring-line dark:ring-slate-700"
              />
              <EntityActionsBar entityKind={ENTITY_KIND} entityId={a.id} />
            </div>
            <div className="min-w-0 space-y-4">
          {/* Native fields, reshaped by the workspace's field-presentation
              overrides — a bundle/config can relabel (e.g. Manufacturer → Make)
              or hide the ones a focused use-case doesn't need. `name` is the
              identity, so it's relabel-only (never hidden). */}
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <EditField label={fp.label("name", "Name")} value={a.name} onCommit={(v) => update.mutate({ name: v })} />
            {!fp.hidden("short_name") && <EditField label={fp.label("short_name", "Short name")} value={a.short_name ?? ""} onCommit={(v) => update.mutate({ short_name: v || null })} />}
            {/* make/model are keyed on their value so a guarded-auto VIN fill
                (which mutates + refetches) actually re-renders these otherwise
                uncontrolled inputs. */}
            {!fp.hidden("manufacturer") && <EditField key={`mfr-${a.manufacturer ?? ""}`} label={fp.label("manufacturer", "Manufacturer")} value={a.manufacturer ?? ""} onCommit={(v) => update.mutate({ manufacturer: v || null })} />}
            {!fp.hidden("model") && <EditField key={`mdl-${a.model ?? ""}`} label={fp.label("model", "Model")} value={a.model ?? ""} onCommit={(v) => update.mutate({ model: v || null })} />}
            {!fp.hidden("type") && <EditField label={fp.label("type", "Type")} value={a.type ?? ""} onCommit={(v) => update.mutate({ type: v || null })} />}
            {!fp.hidden("state") && <EditField label={fp.label("state", "State")} value={a.state} onCommit={(v) => update.mutate({ state: v })} />}
            {!fp.hidden("serial_number") &&
              (/\bvin\b/i.test(fp.label("serial_number", "Serial number")) ? (
                <VinDecodeField
                  a={a}
                  fp={fp}
                  fieldDefs={fieldDefs.data?.items ?? []}
                  slug={activeSlug}
                  onPatch={(patch) => update.mutate(patch)}
                />
              ) : (
                <EditField label={fp.label("serial_number", "Serial number")} value={a.serial_number ?? ""} onCommit={(v) => update.mutate({ serial_number: v || null })} />
              ))}
            {!fp.hidden("purchased_at") && <EditField label={fp.label("purchased_at", "Purchased at")} value={a.purchased_at ?? ""} onCommit={(v) => update.mutate({ purchased_at: v || null })} type="date" />}
            {!fp.hidden("warranty_until") && <EditField label={fp.label("warranty_until", "Warranty until")} value={a.warranty_until ?? ""} onCommit={(v) => update.mutate({ warranty_until: v || null })} type="date" />}
            {!fp.hidden("last_service_at") && <EditField label={fp.label("last_service_at", "Last service")} value={a.last_service_at ?? ""} onCommit={(v) => update.mutate({ last_service_at: v || null })} type="date" />}
            {!fp.hidden("quantity") && <EditField label={fp.label("quantity", "Quantity")} value={String(a.quantity)} numeric onCommit={(v) => update.mutate({ quantity: Number(v) || 0 })} />}
            <LocationPicker
              label="Location"
              value={a.location_id}
              onChange={(id) => update.mutate({ location_id: id })}
              size="sm"
            />
          </dl>
          <CustomFieldsPanel
            entityKind={kind}
            entityId={a.id}
            values={a.metadata}
            onCommit={(name, value) =>
              update.mutate({ metadata: { ...a.metadata, [name]: value } })
            }
          />
          {/* What's inside this asset — e.g. the components in a server/computer.
              Same generic placement panel a machine or a drawer uses. */}
          <ContentsPanel slug={activeSlug} container={{ kind: ENTITY_KIND, id: a.id }} title="Contents" />
          <EntityAttachments kind={ENTITY_KIND} entityId={a.id} />
          <EditField label="Notes" value={a.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />
            </div>
          </div>
          <div className="pt-3 border-t border-line dark:border-slate-700 flex items-center justify-between">
            <button
              onClick={handleDelete}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> delete asset
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      ) : asset.isError ? (
        // Don't sit on "loading…" forever when the fetch fails (a 404, a stale
        // service-worker chunk hitting the wrong route, an auth blip). Say what
        // went wrong + offer a retry, so it's never a silent mystery.
        <div className="space-y-2 py-2 text-sm">
          <div className="text-ember-600 dark:text-ember-400">
            Couldn't load this {instance ? "record" : "asset"}
            {asset.error instanceof ApiError ? `: ${asset.error.message}` : "."}
          </div>
          <button
            type="button"
            onClick={() => void asset.refetch()}
            className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-content dark:text-mortar-200 hover:border-accent transition"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="text-xs text-faint">loading…</div>
      )}
    </Modal>
  );
}

function NewAssetModal({
  open,
  onClose,
  instance,
  noun = "asset",
}: { open: boolean; onClose: () => void; instance?: string; noun?: string }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  // A bundle relabels this per kind (Vehicles: manufacturer -> "Make"). Hardcode it
  // and the workspace's own rename silently never reaches this form.
  const fp = useFieldPresentation(instance ? `${instance}:item` : ENTITY_KIND);
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [category, setCategory] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setManufacturer("");
      setCategory("");
      setLocationId(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createAsset(activeSlug, {
        name: name.trim(),
        manufacturer: manufacturer.trim() || null,
        type: category.trim() || null,
        location_id: locationId,
      }, instance),
    onSuccess: (a) => {
      toast.success(`${noun[0]!.toUpperCase()}${noun.slice(1)} added.`);
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
      onClose();
      // On an instance page stay in the instance and deep-link the new record's
      // detail; on the base page go to /assets/:id as before.
      navigate(instance ? `/${instance}?asset=${a.id}` : `/assets/${a.id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="New asset" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{fp.label("manufacturer", "Manufacturer")}</span>
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Type / category</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder='e.g. "Appliance", "Hand tool"' className="input" />
        </label>
        <LocationPicker
          label="Location"
          value={locationId}
          onChange={setLocationId}
        />
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || create.isPending} className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditField({
  label,
  value,
  onCommit,
  numeric,
  multiline,
  type,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  numeric?: boolean;
  multiline?: boolean;
  type?: string;
}) {
  const Cmp = multiline ? "textarea" : "input";
  return (
    <label className={"block " + (multiline ? "col-span-2" : "")}>
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      <Cmp
        type={type ?? (numeric ? "number" : "text")}
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value !== value) onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!multiline && e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        rows={multiline ? 3 : undefined}
        className="input"
      />
    </label>
  );
}

// ── Guarded-auto VIN decode ───────────────────────────────────────────────────
// Renders the "VIN" field (the relabeled serial_number) as a controlled input
// with guarded-auto decode: when the field holds a COMPLETE shape-valid VIN, it
// calls the identifier-decoder endpoint and FILLS ONLY EMPTY target fields
// (make/model/year/…), mapped BY ROLE/NAME (never by hardcoded id, so it serves
// any table with those fields). Fills are provenance-chipped, trivially
// undoable, and a manual "Decode" affordance stays for the on-paper case. It
// only renders when the field is labelled "VIN" (see the caller), so forms
// without a VIN field are untouched.

type VinStatus =
  | { kind: "idle" }
  | { kind: "decoding" }
  | { kind: "filled"; outcome: "hit" | "partial"; note?: string; fills: VinFill[] }
  | { kind: "no-fill"; outcome: "hit" | "partial"; note?: string }
  | { kind: "miss" }
  | { kind: "unavailable" };

const isBlankVal = (v: unknown): boolean => v === null || v === undefined || v === "";

function VinDecodeField({
  a,
  fp,
  fieldDefs,
  slug,
  onPatch,
}: {
  a: Asset;
  fp: ReturnType<typeof useFieldPresentation>;
  fieldDefs: PlatformFieldDef[];
  slug: string;
  onPatch: (patch: Partial<Asset>) => void;
}) {
  const [vin, setVin] = useState(a.serial_number ?? "");
  const [status, setStatus] = useState<VinStatus>({ kind: "idle" });
  useEffect(() => {
    setVin(a.serial_number ?? "");
  }, [a.serial_number]);

  const decode = useMutation({ mutationFn: (code: string) => api.decodeIdentifier(slug, code) });

  // Build the generic target set: native make/model + every plain declared
  // field. planVinFill decides which decoded key lands where, by role/name.
  function buildTargets(): VinFillTarget[] {
    const targets: VinFillTarget[] = [
      { id: "native:manufacturer", name: "manufacturer", label: fp.label("manufacturer", "Manufacturer"), empty: isBlankVal(a.manufacturer) },
      { id: "native:model", name: "model", label: fp.label("model", "Model"), empty: isBlankVal(a.model) },
    ];
    for (const d of fieldDefs) {
      if (d.type !== "text" && d.type !== "number") continue; // only plainly fillable fields
      if (d.name === "serial_number") continue; // never the VIN field itself
      targets.push({
        id: `meta:${d.name}`,
        name: d.name,
        label: d.display_label,
        empty: isBlankVal(a.metadata?.[d.name]),
        // A bundle-declared decode role (`decode:year`) targets this field
        // precisely; absent → planVinFill falls back to name matching.
        role: d.decode_role ?? null,
      });
    }
    return targets;
  }

  function fillsToPatch(fills: VinFill[], clear: boolean): Partial<Asset> {
    const patch: Partial<Asset> = {};
    let meta: Record<string, unknown> | null = null;
    for (const f of fills) {
      if (f.target.id === "native:manufacturer") patch.manufacturer = clear ? null : String(f.value);
      else if (f.target.id === "native:model") patch.model = clear ? null : String(f.value);
      else if (f.target.id.startsWith("meta:")) {
        meta = meta ?? { ...(a.metadata ?? {}) };
        meta[f.target.name] = clear ? "" : f.value;
      }
    }
    if (meta) patch.metadata = meta;
    return patch;
  }

  async function runDecode(code: string) {
    setStatus({ kind: "decoding" });
    try {
      const res = await decode.mutateAsync(code);
      if (res.outcome === "hit" || res.outcome === "partial") {
        const plan = planVinFill(res.fields, buildTargets());
        if (plan.length > 0) {
          onPatch(fillsToPatch(plan, false));
          setStatus({ kind: "filled", outcome: res.outcome, note: res.note, fills: plan });
        } else {
          setStatus({ kind: "no-fill", outcome: res.outcome, note: res.note });
        }
      } else if (res.outcome === "miss") {
        setStatus({ kind: "miss" });
      } else {
        setStatus({ kind: "unavailable" });
      }
    } catch {
      setStatus({ kind: "unavailable" });
    }
  }

  function commit() {
    const v = vin.trim().toUpperCase();
    if (v !== (a.serial_number ?? "")) onPatch({ serial_number: v || null });
    // Guarded-auto: fire ONLY on a complete shape-valid VIN. onBlur is the debounce.
    if (isShapeValidVin(v)) void runDecode(v);
  }

  function undo() {
    if (status.kind !== "filled") return;
    onPatch(fillsToPatch(status.fills, true));
    setStatus({ kind: "idle" });
  }

  const shapeValid = isShapeValidVin(vin);
  const decoding = status.kind === "decoding";

  return (
    <label className="block col-span-2">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {fp.label("serial_number", "VIN")}
      </span>
      <div className="flex items-center gap-2">
        <input
          value={vin}
          onChange={(e) => setVin(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          spellCheck={false}
          autoCapitalize="characters"
          className="input flex-1 font-mono tracking-wide"
          placeholder="17-character VIN"
        />
        <button
          type="button"
          disabled={!shapeValid || decoding}
          onClick={() => void runDecode(vin.trim().toUpperCase())}
          title={shapeValid ? "Decode this VIN" : "Enter a complete 17-character VIN"}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium bg-subtle dark:bg-slate-800 hover:bg-line dark:hover:bg-slate-700 disabled:opacity-40 transition"
        >
          {decoding ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          {decoding ? "Decoding…" : "Decode"}
        </button>
      </div>

      {status.kind === "filled" && (
        <div className="mt-2 rounded-md border border-cobble-300/60 dark:border-cobble-800 bg-cobble-50/60 dark:bg-cobble-950/40 px-2.5 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-content dark:text-slate-300">
              Filled from VIN - double-check{status.outcome === "partial" ? " (partial match)" : ""}.
            </span>
            <button type="button" onClick={undo} className="inline-flex items-center gap-1 text-faint hover:text-ember-500 transition">
              <Undo2 size={11} /> undo
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {status.fills.map((f) => (
              <span
                key={f.target.id}
                className="inline-flex items-center gap-1 rounded-full bg-cobble-100 dark:bg-cobble-900/60 text-cobble-800 dark:text-cobble-200 px-2 py-0.5 text-[10px] font-medium"
              >
                {f.target.label}: {String(f.value)}
              </span>
            ))}
          </div>
          {status.note && <div className="mt-1 text-[10px] text-faint">{status.note}</div>}
        </div>
      )}
      {status.kind === "no-fill" && (
        <div className="mt-2 text-[11px] text-faint">
          Decoded, but every matching field is already filled. {status.note ?? ""}
        </div>
      )}
      {status.kind === "miss" && (
        <div className="mt-2 text-[11px] text-faint">Couldn&apos;t decode that VIN - check for typos.</div>
      )}
      {status.kind === "unavailable" && (
        <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          VIN service unavailable - try again in a moment.
        </div>
      )}
    </label>
  );
}
