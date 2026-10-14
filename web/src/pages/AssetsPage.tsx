import { useCloseToOrigin, useNewRecordBarcode, RecordFormModal, NewItemMenu, MoneyTotalNotice, useMoneyCurrency, PresentationGate, useFaces, usePlatformWeb, UsedValueInput, usedValueFieldItem } from "@cobblr/platform-web";
// /assets — list + detail modal for the assets module. Same shape
// as MachinesPage. No specialisations yet (no assets:asset Pillar-E
// modules ship), so no lens UI here — but the column rendering is
// already lens-ready: when a future "Vintage Tools" or
// "Collectibles" module contributes field-defs, they'll appear as
// extra columns automatically (no code change here).

import { readRecordDisposition } from "@cobblr/platform-contract/disposition";
import { lentWhy, readRecordLoan } from "@cobblr/platform-contract/loan";
import { useEffect, useState, type FormEvent } from "react";
import { RecordPhoto } from "../components/RecordPhoto";
import { pictureStateFor, suggestedSrcFor, usePhotoSuggestions } from "../lib/photoSuggestions";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ChevronRight, Loader2, Plus, Printer, Sprout, Trash2, Undo2, Wand2 } from "lucide-react";
import { ApiError, api, getToken, type Asset, type OrgModuleListItem, type PlatformFieldDef } from "../lib/api";
import { isShapeValidVin, planVinFill, type VinFill, type VinFillTarget } from "../lib/vin";
import { ModuleInstanceChooser } from "../components/ModuleInstanceChooser";
import { queueLabelsBulk } from "../lib/queue-label";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { CustomFieldsPanel,
  BulkGiveTo,
  BulkShareWith,
  EditField, EntityActionsBar, FaceSection, FieldPack, RecordFaces,
  FacesOn, faceShows, editFieldItem, moneyFieldItem, fieldNeed, EditSelect,
  useAskCobbAboutSelection,
  useTickedRows,
  useToast,
  useConfirm, usePageTitle, usePageWidth, TILE_GRID, InboxWaitingStrip, SearchInput, CollectionHeader, HEADER_CONTROL, headerButton } from "@cobblr/platform-web";
import {
  BulkActionBar, BulkSetField,
  MoveToInstanceModal,
  MoveToInstancePanel,
  FooterActionPopover,
  BulkTagAction,
  EntityThumb,
  PhoneRecordList,
  usePhoneLayout,
  EntityTile,
  ViewModeToggle,
  useViewMode,
} from "@cobblr/platform-web";
import { EntityAttachments } from "../components/EntityAttachments";
import { ContributedDetailPanels } from "../panels/registry";
import { LocationTreePicker } from "../components/LocationTreePicker";
import { ContentsPanel, useHoldsContents } from "../components/ContentsPanel";
import { useDeclaredChoices } from "../components/ViewBuilder";
import { countOf, itemNounFor, pluralise } from "@cobblr/platform-contract/plural";
import { resolveDetailPath } from "@cobblr/platform-contract/instance-detail";
import { fieldCurrency, formatMoney, toCents } from "@cobblr/platform-contract/money";

const ENTITY_KIND = "assets:asset";

export function AssetsPage({
  instance,
  displayName,
  itemNoun,
  itemNounPlural,
  hint,
}: { instance?: string; displayName?: string; itemNoun?: string; itemNounPlural?: string; hint?: string | null } = {}) {
  // When `instance` is set we render ONE named collection of assets (e.g.
  // "Vehicles"), reached at the clean /<instance> URL — the SAME rich page as
  // /assets (thumbnails, views, detail/edit), just scoped to the instance's
  // items. No lens/instance-chooser (the instance IS the focus), and detail is
  // local state (no /<instance>/:id route). Mirrors MachinesPage.
  // A wide table is the page here, so it gets the screen.
  usePageWidth("wide");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const lensName = instance ? null : searchParams.get("lens");
  const viewId = searchParams.get("view");

  // On an instance page, fields/views are keyed to the instance ("vehicles:item")
  // rather than the base assets:asset. Mirrors MachinesPage's viewKind.
  const entityKind = instance ? `${instance}:item` : ENTITY_KIND;
  // Not the module's own word: a named collection that never had a noun set
  // read "New asset" regardless of what it holds. itemNounFor asks the noun
  // somebody set, then the kind, and stops at the neutral "item".
  const noun = itemNounFor({ itemNoun, entityKind });
  const nounPlural = itemNounPlural?.trim() || pluralise(noun);
  const words = { singular: noun, plural: nounPlural };
  const heading = displayName ?? nounPlural.charAt(0).toUpperCase() + nounPlural.slice(1);
  usePageTitle(heading);

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
    } else {
      // RECORD-LINK-OK: the module's own page opening its own default-collection record in place; its base route is this page.
      navigate(`/assets/${aid}${searchParams.toString() ? `?${searchParams}` : ""}`);
    }
  };
  // A record opened from somewhere else (a floor plan, a search) closes back
  // there; one opened by its link closes to the list (#6266).
  const closeToList = useCloseToOrigin(`/assets${searchParams.toString() ? `?${searchParams}` : ""}`);
  const closeDetail = () => {
    if (instance) {
      setLocalSel(null);
      setSearchParams((prev) => { prev.delete("asset"); return prev; }, { replace: true });
    } else closeToList();
  };

  // What is put away is its own list, one tap from the register.
  const showArchived = searchParams.get("archived") === "1";
  const setShowArchived = (on: boolean) =>
    setSearchParams((prev) => { if (on) prev.set("archived", "1"); else prev.delete("archived"); return prev; }, { replace: true });
  const list = useQuery({
    queryKey: ["assets", activeSlug, instance ?? null, showArchived],
    queryFn: () => api.listAssets(activeSlug, instance, { archived: showArchived }),
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
  const groupBy = typeof activeView?.config?.group_by === "string" ? activeView.config.group_by : undefined;
  useEffect(() => {
    if (activeView?.view_type === "table" && activeView.config?.group_by) navigate(`/views/${activeView.id}`, { replace: true });
  }, [activeView, navigate]);
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
  // What the register cost: every asset still yours, summed by the server (a
  // sold or given-away one is out of it, and so is one past this page).
  const paidTotal = toCents(list.data?.paid_total_cents ?? 0);
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
  const [selected, setSelected, clearTicks] = useTickedRows(list.data ? allRows.map((r) => r.id) : null);

  // What is ticked IS context: with the panel open, "delete these" means the
  // ones on screen a person pointed at, and Cobb gets their ids rather than a
  // count he has to go and re-find.
  const askCobb = useAskCobbAboutSelection(selected, rows, "assets:asset", "asset");
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
      toast.success(`Deleted ${countOf(selected.size, words)}`);
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
      toast.success(`Tagged ${countOf(selected.size, words)}`);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <CollectionHeader
        title={heading}
        count={showArchived ? `${list.data?.total ?? allRows.length} gone or put away` : `${filtered.length} of ${list.data?.total ?? allRows.length}${paidTotal > 0 ? ` · paid ${formatMoney(paidTotal, { currency: list.data?.money_total?.currency })} in all` : ""}`}
        hint={hint} kind={instance ? `${instance}:item` : ENTITY_KIND}
        filters={
          (list.data?.archived_count ?? 0) > 0 || showArchived ? (
            <button
              type="button"
              onClick={() => setShowArchived(!showArchived)}
              aria-pressed={showArchived}
              className={`${HEADER_CONTROL} px-2.5 rounded-md text-[10px] uppercase tracking-widest transition ${showArchived ? "bg-cobble-100 text-accent dark:bg-cobble-700/40 dark:text-cobble-200" : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800"}`}
            >
              {showArchived ? "Back to the register" : `Gone or put away (${list.data?.archived_count ?? 0})`}
            </button>
          ) : lensModule ? (
            <Link
              to="/assets"
              className={`${HEADER_CONTROL} gap-1 px-2.5 rounded-md bg-cobble-100 text-accent dark:bg-cobble-700/40 dark:text-cobble-200 text-[10px] uppercase tracking-widest hover:bg-cobble-200 transition`}
              title="Clear lens"
            >
              lens: {lensModule.displayName} ×
            </Link>
          ) : undefined
        }
        search={<SearchInput value={query} onChange={setQuery} placeholder="search…" aria-label={`Search ${nounPlural}`} wrapperClassName="w-48 max-sm:w-full max-sm:flex-1" />}
        exportQuery={query}
        actions={
          <>
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
            <NewItemMenu kind="assets:asset" instance={instance}>
              <button onClick={() => setNewOpen(true)} className={headerButton("primary")}>
                <Plus size={14} /> New {noun}
              </button>
            </NewItemMenu>
          </>
        }
      />
      <MoneyTotalNotice total={list.data?.money_total} />

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
              ? `No ${nounPlural} yet. Add one with New ${noun}.`
              : activeView
                ? `Nothing in “${activeView.name}” yet. Add your first with New ${noun}.`
                : "No matches with the current filters."}
          </div>
        )
      ) : groupBy ? (
        groupItems(filtered, groupBy).map((g) => (
          <div key={g.key} className="space-y-2">
            <h3 className="text-xs uppercase tracking-widest text-accent">{g.key}</h3>
            {viewMode === "tiles" ? (
              <AssetsTiles rows={g.rows} onOpen={openAsset} kind={instance ? `${instance}:item` : ENTITY_KIND} />
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
        <AssetsTiles rows={filtered} onOpen={openAsset} kind={instance ? `${instance}:item` : ENTITY_KIND} />
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
      {/* What is waiting in the scan inbox to come here, under the filed
          results: a thing just scanned is in no table until it is filed. */}
      <InboxWaitingStrip destination={instance ?? "assets"} q={query} />

      <AssetDetailModal
        assetId={selectedId}
        onClose={closeDetail}
        instance={instance}
        noun={noun}
      />
      <NewAssetModal open={newOpen} onClose={() => setNewOpen(false)} instance={instance} noun={noun} />

      <BulkActionBar
        records={{ kind: entityKind, ids: Array.from(selected) }}
        onAskCobb={askCobb}
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={
          <>
            <BulkSetField records={Array.from(selected).map((id) => ({ kind: entityKind, id }))} onDone={() => setSelected(new Set())} />
            <BulkTagAction count={selected.size} placeholder="e.g. urgent, summer-2026, archive" onTag={(name) => bulkTag.mutateAsync(name)} />
            <BulkGiveTo kind={entityKind} ids={Array.from(selected)} noun={noun} onDone={clearTicks} />
            <BulkShareWith kind={entityKind} ids={Array.from(selected)} noun={noun} onDone={clearTicks} />
            <FooterActionPopover label="Move to…" icon={<ArrowRightLeft size={12} />} title="Move to another list" width={360} data-testid="bulk-move">
              {(close) => (
                <div className="overflow-y-auto p-3">
                  <MoveToInstancePanel
                    slug={activeSlug ?? ""}
                    getToken={getToken}
                    moduleName="assets"
                    fromInstance={instance ?? "assets"}
                    ids={Array.from(selected)}
                    noun={noun}
                    onClose={close}
                    onMoved={(n, where, undo) => {
                      const tickAgain = clearTicks();
                      toast.action(`Moved ${countOf(n, words)} to ${where}.`, {
                        actionLabel: "Undo",
                        duration: 10_000,
                        onAction: async () => {
                          await undo();
                          void qc.invalidateQueries({ queryKey: ["assets"] });
                          tickAgain();
                        },
                      });
                      void qc.invalidateQueries({ queryKey: ["assets"] });
                    }}
                  />
                </div>
              )}
            </FooterActionPopover>
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
                  title: `Delete ${countOf(selected.size, words)}?`,
                  message: "This is permanent, the rows will be removed from the workspace.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) bulkDelete.mutate(Array.from(selected));
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-ember-600 dark:text-ember-400 hover:text-ember-700 disabled:opacity-50"
            >
              <Trash2 size={12} /> Delete
            </button>
          </>
        }
      />
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

function AssetsTiles({ rows, onOpen, kind }: { rows: Asset[]; onOpen: (id: string) => void; kind: string }) {
  const suggestions = usePhotoSuggestions(kind, rows.map((a) => a.id));
  return (
    <div className={TILE_GRID}>
      {rows.map((a) => (
        <button key={a.id} type="button" onClick={() => onOpen(a.id)} className="text-left">
          <EntityTile
            src={a.image_path}
            suggestedSrc={suggestedSrcFor(suggestions, a.id, a.image_path)} pictureState={pictureStateFor(suggestions, a.id, a.image_path)}
            title={a.name}
            subtitle={a.manufacturer || a.model || a.short_name || null}
            badge={a.state}
            count={a.quantity}
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
  const suggestions = usePhotoSuggestions(instance ? `${instance}:item` : ENTITY_KIND, rows.map((a) => a.id));
  // The column header must respect a bundle relabel too, or the list says
  // "Manufacturer" while the detail page says "Make".
  const fp = useFieldPresentation(instance ? `${instance}:item` : ENTITY_KIND);
  const phone = usePhoneLayout();
  if (phone) {
    return (
      <PhoneRecordList
        rows={rows.map((a) => ({
          id: a.id,
          name: a.name,
          picture: <EntityThumb src={a.image_path} suggestedSrc={suggestedSrcFor(suggestions, a.id, a.image_path)} pictureState={pictureStateFor(suggestions, a.id, a.image_path)} alt={a.name} size={40} />,
          state: a.state,
          identity: [a.manufacturer, a.model, fp.hidden("type") ? null : a.type],
          fields: customCols.map((d) => {
            const v = (a.metadata as Record<string, unknown>)[d.name];
            return { label: d.display_label, value: v === null || v === undefined || v === "" ? null : String(v) };
          }),
          quantity: a.quantity,
        }))}
        onOpen={onOpen}
        selection={{ selected, onToggle, onSelectAll }}
      />
    );
  }
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
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
            {/* The asset's category, typed or scanned: one field (#4115). */}
            {!fp.hidden("type") && <th className="text-left px-3 py-2">{fp.label("type", "Type")}</th>}
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
                  <EntityThumb src={a.image_path} suggestedSrc={suggestedSrcFor(suggestions, a.id, a.image_path)} pictureState={pictureStateFor(suggestions, a.id, a.image_path)} alt={a.name} size={56} />
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
              {!fp.hidden("type") && <td className="px-3 py-2 text-muted dark:text-slate-400">{a.type || "—"}</td>}
              <td className="px-3 py-2">
                <span className="text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
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

export function AssetDetailModal({
  assetId,
  onClose,
  instance,
  noun: tableNoun,
}: { assetId: string | null; onClose: () => void; instance?: string; noun?: string }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const noun = itemNounFor({ itemNoun: tableNoun, entityKind: instance ? `${instance}:item` : ENTITY_KIND });
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  // On an instance page the item lives under /instances/<name>/items and its
  // custom fields are keyed to the instance ("vehicles:item"), NOT the base
  // assets:asset — reading/writing without the instance 404s (the modal then
  // hangs on "loading…"). Thread it through every asset call + the field kind.
  const kind = instance ? `${instance}:item` : ENTITY_KIND;
  const [moveOpen, setMoveOpen] = useState(false);
  const fp = useFieldPresentation(kind);
  const { api: platformApi } = usePlatformWeb();
  const declaredActions = useQuery({
    queryKey: ["platform-actions", activeSlug, ENTITY_KIND],
    queryFn: () => platformApi.listActions(activeSlug, ENTITY_KIND),
    staleTime: 60_000,
  });
  const moveDescription = declaredActions.data?.items.find((action) => action.id === "core-placement:place")?.description;
  const refreshPlace = () => {
    void qc.invalidateQueries({ queryKey: ["asset", activeSlug, instance ?? null, assetId] });
    void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
  };
  // The states the kind declares, in the order a thing lives them. Every
  // collection of assets shares the base kind's native state field.
  const assetStates = useDeclaredChoices(activeSlug, ENTITY_KIND, "state");
  const holdsContents = useHoldsContents(activeSlug, { kind: ENTITY_KIND, id: assetId ?? "" });
  // The collection's faces decide sections and verbs; the body waits for them.
  const shape = useFaces(kind);
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
    onError: (e: unknown) => toast.error(`Couldn't save that change: ${e instanceof ApiError ? e.message : String(e)}`),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAsset(activeSlug, assetId!, instance),
    onSuccess: () => {
      toast.success(`${Noun} deleted.`);
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const a = asset.data;
  const mainCurrency = useMoneyCurrency();
  async function handleDelete() {
    if (!a) return;
    const ok = await confirm({
      title: `Delete "${a.name}"?`,
      message: "You can restore this record from Recently deleted for 30 days.",
      confirmLabel: `Delete ${noun}`,
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
    <RecordFormModal open={!!assetId} onClose={onClose} title={a?.name ?? (asset.isError ? "Couldn't load" : "loading…")} subtitle={subtitle}>
      {a ? (
        <PresentationGate ready={fp.ready && shape.ready} failed={fp.failed || shape.failed} retry={() => { fp.retry(); shape.retry(); }}>
        <div className="space-y-4">
          {/* Wide record layout: the cover large on the LEFT, fields on the
              RIGHT — so an image-bearing record (a book, a wine, a machine)
              uses the width instead of scrolling tall. Stacks on phones. */}
          <RecordFaces kind={kind}>
          <ContributedDetailPanels
            target={ENTITY_KIND}
            placement="summary"
            ctx={{ slug: activeSlug, entityId: a.id, entityTitle: a.name, hints: { collection: instance ? `${instance}:item` : undefined } }}
          />
          <div className="grid gap-6 md:grid-cols-[minmax(200px,260px)_1fr]">
            <div className="space-y-3">
              <RecordPhoto
                kind={kind}
                id={a.id}
                instance={instance ?? null}
                src={a.image_path}
                alt={a.name}
                brand={a.manufacturer}
                size={256}
                onChange={(image_path) => update.mutate({ image_path })}
                onSaved={() => {
                  void qc.invalidateQueries({ queryKey: ["asset", activeSlug, instance ?? null, assetId] });
                  void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
                }}
              />
              {a.archived_at && !readRecordDisposition(a.metadata) ? (
                <p className="text-xs text-muted dark:text-slate-400">
                  Archived on {new Date(a.archived_at).toLocaleDateString()}. It keeps its history; Restore to the register brings it back.
                </p>
              ) : null}
              {fp.hidden("location_id") && readRecordLoan(a.metadata) ? (
                // Lent out: it keeps the place it returns to, and moves once it is back.
                <button type="button" disabled title={lentWhy(readRecordLoan(a.metadata)!)} className="rounded border border-line px-2 py-1 text-xs text-muted opacity-50 dark:border-slate-600">
                  Move to…
                </button>
              ) : fp.hidden("location_id") && (
                <LocationTreePicker triggerLabel="Move to…" description={moveDescription ?? undefined} value={a.location_id} onChange={(id) => update.mutate({ location_id: id })} size="sm" thing={{ kind: ENTITY_KIND, id: a.id }} onPlaced={refreshPlace} />
              )}
              <EntityActionsBar
                entityKind={ENTITY_KIND}
                entityId={a.id}
                overflowActionIds={["assets:archive"]}
                excludeActionIds={[
                  // A thing that was sold or given away comes back through
                  // Bring back on its line; Put away and Restore are for the
                  // shelf, not for that.
                  ...(readRecordDisposition(a.metadata) ? ["assets:archive", "assets:restore"] : []),
                  // Lend… and It's back on the loan line are this page's door
                  // for lending (record-loans.md); the asset's own pair runs
                  // the same loan for a station and the assistant.
                  "assets:lend",
                  "assets:got-back",
                  a.archived_at ? "assets:archive" : "assets:restore",
                ]}
              />
            </div>
            <div className="min-w-0 space-y-4">
          {/* Native fields, reshaped by the workspace's field-presentation
              overrides — a bundle/config can relabel (e.g. Manufacturer → Make)
              or hide the ones a focused use-case doesn't need. `name` is the
              identity, so it's relabel-only (never hidden). */}
          {/* The service and stock faces decide whether their fields are on
              the record at all (no cell, not an empty one), read from inside
              the record's faces: this component mounts RecordFaces, so a
              hook in its own body would run outside it and answer true. */}
          <FacesOn kind={kind} faces={["maintained", "stock"] as const}>
            {({ maintained: maintainedOn, stock: stockOn }) => (
          <FieldPack
            className="text-xs"
            items={[
              editFieldItem("name", { label: fp.label("name", "Name"), value: a.name, onCommit: (v) => update.mutate({ name: v }) }),
              !fp.hidden("short_name") ? editFieldItem("short_name", { label: fp.label("short_name", "Short name"), value: a.short_name ?? "", onCommit: (v) => update.mutate({ short_name: v || null }) }) : null,
              // make/model are keyed on their value so a guarded-auto VIN fill
              // (which mutates + refetches) actually re-renders these otherwise
              // uncontrolled inputs.
              !fp.hidden("manufacturer") ? { need: fieldNeed("manufacturer", { control: "text", label: fp.label("manufacturer", "Manufacturer"), valueLength: (a.manufacturer ?? "").length }), node: usedValueFieldItem("manufacturer", { label: fp.label("manufacturer", "Manufacturer"), kind, field: "manufacturer", value: a.manufacturer ?? null, onCommit: (v) => update.mutate({ manufacturer: v || null }) }).node } : null,
              !fp.hidden("model") ? { need: fieldNeed("model", { control: "text", label: fp.label("model", "Model"), valueLength: (a.model ?? "").length }), node: <EditField key={`mdl-${a.model ?? ""}`} label={fp.label("model", "Model")} value={a.model ?? ""} onCommit={(v) => update.mutate({ model: v || null })} /> } : null,
              !fp.hidden("type") ? editFieldItem("type", { label: fp.label("type", "Type"), value: a.type ?? "", onCommit: (v) => update.mutate({ type: v || null }) }) : null,
              !fp.hidden("state")
                ? assetStates.length > 0
                  ? {
                      need: fieldNeed("state", { control: "choice", label: fp.label("state", "State"), choices: assetStates }),
                      node: <EditSelect label={fp.label("state", "State")} value={a.state} options={assetStates} onCommit={(v) => update.mutate({ state: v })} />,
                    }
                  : editFieldItem("state", { label: fp.label("state", "State"), value: a.state, onCommit: (v) => update.mutate({ state: v }) })
                : null,
              // A VIN carries its decode button and the fill it proposes under
              // it: the row, whatever the width.
              !fp.hidden("serial_number")
                ? /\bvin\b/i.test(fp.label("serial_number", "Serial number"))
                  ? { need: { key: "serial_number", minPx: 320, full: true }, node: <VinDecodeField a={a} fp={fp} fieldDefs={fieldDefs.data?.items ?? []} slug={activeSlug} onPatch={(patch) => update.mutate(patch)} /> }
                  : editFieldItem("serial_number", { label: fp.label("serial_number", "Serial number"), value: a.serial_number ?? "", onCommit: (v) => update.mutate({ serial_number: v || null }) })
                : null,
              !fp.hidden("purchased_at") ? editFieldItem("purchased_at", { label: fp.label("purchased_at", "Purchased at"), value: a.purchased_at ?? "", type: "date", onCommit: (v) => update.mutate({ purchased_at: v || null }) }) : null,
              !fp.hidden("purchase_price_cents")
                ? moneyFieldItem("purchase_price_cents", {
                    // Once parts are installed in it, what was paid for it is the
                    // rest of its value: the parts are counted as themselves, and
                    // its total (under Contents) adds them, each once.
                    label: holdsContents ? "Other value (not itemized)" : fp.label("purchase_price_cents", "Paid"),
                    value: a.purchase_price_cents,
                    currency: fieldCurrency(a.metadata, "purchase_price_cents", mainCurrency),
                    onCurrencyChange: (currency) => update.mutate({ metadata: { money_currency_purchase_price_cents: currency } }),
                    storage: "cents",
                    onCommit: (cents) => update.mutate({ purchase_price_cents: cents }),
                  })
                : null,
              !fp.hidden("vendor") ? editFieldItem("vendor", { label: fp.label("vendor", "Bought from"), value: a.vendor ?? "", onCommit: (v) => update.mutate({ vendor: v.trim() || null }) }) : null,
              // Service face: warranty + last service. Off folds them while empty; a date already set stays.
              !fp.hidden("warranty_until") && faceShows(maintainedOn, a.warranty_until) ? editFieldItem("warranty_until", { label: fp.label("warranty_until", "Warranty until"), value: a.warranty_until ?? "", type: "date", onCommit: (v) => update.mutate({ warranty_until: v || null }) }) : null,
              !fp.hidden("last_service_at") && faceShows(maintainedOn, a.last_service_at) ? editFieldItem("last_service_at", { label: fp.label("last_service_at", "Last service"), value: a.last_service_at ?? "", type: "date", onCommit: (v) => update.mutate({ last_service_at: v || null }) }) : null,
              !fp.hidden("quantity") && faceShows(stockOn, a.quantity, 1) ? editFieldItem("quantity", { label: fp.label("quantity", "Quantity"), value: String(a.quantity), numeric: true, onCommit: (v) => update.mutate({ quantity: Number(v) || 0 }) }) : null,
              !fp.hidden("location_id") ? {
                need: fieldNeed("location", { control: "picker", label: "Location" }),
                node: <LocationTreePicker label="Location" value={a.location_id} onChange={(id) => update.mutate({ location_id: id })} size="sm" thing={{ kind: "assets:asset", id: a.id }} onPlaced={refreshPlace} />,
              } : null,
            ]}
          />
            )}
          </FacesOn>
          <CustomFieldsPanel
            entityKind={kind}
            entityId={a.id}
            values={a.metadata}
            onCommit={(name, value) =>
              update.mutate({ metadata: { [name]: value } })
            }
          />
          {/* What's inside this asset — e.g. the components in a server/computer.
              Same generic placement panel a machine or a drawer uses. */}
          <FaceSection face="container" kind={kind} holds={holdsContents}>
            <ContentsPanel slug={activeSlug} container={{ kind: ENTITY_KIND, id: a.id }} title="Contents" builtFrom wordKind={kind} />
          </FaceSection>
          {/* What other modules add to an asset (its service schedule, tags,
              the discussion) arrives as contributed panels, so the attachment
              pills leave tags and discussion to them rather than show each twice. */}
          <ContributedDetailPanels
            target={ENTITY_KIND}
            placement="details"
            ctx={{ slug: activeSlug, entityId: a.id, entityTitle: a.name, hints: { collection: instance ? `${instance}:item` : undefined } }}
          />
          <EntityAttachments kind={ENTITY_KIND} entityId={a.id} collection={instance ? `${instance}:item` : undefined} omit={["tags", "discussion", "pairings"]} />
          <EditField label="Notes" value={a.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />
            </div>
          </div>
          <div className="pt-3 border-t border-line dark:border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={handleDelete}
                className="text-[10px] uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
              >
                <Trash2 size={11} /> delete {noun}
              </button>
              <button
                onClick={() => setMoveOpen(true)}
                className="text-[10px] uppercase tracking-widest text-faint hover:text-accent transition flex items-center gap-1"
              >
                <ArrowRightLeft size={11} /> move to…
              </button>
            </div>
            <MoveToInstanceModal
              open={moveOpen}
              onClose={() => setMoveOpen(false)}
              slug={activeSlug ?? ""}
              getToken={getToken}
              moduleName="assets"
              fromInstance={instance ?? "assets"}
              ids={assetId ? [assetId] : []}
              onMoved={(_n, where) => {
                toast.success(`Moved to ${where}`);
                void qc.invalidateQueries({ queryKey: ["assets"] });
                onClose();
              }}
            />
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
          </RecordFaces>
        </div>
        </PresentationGate>
      ) : asset.isError ? (
        // Don't sit on "loading…" forever when the fetch fails (a 404, a stale
        // service-worker chunk hitting the wrong route, an auth blip). Say what
        // went wrong + offer a retry, so it's never a silent mystery.
        <div className="space-y-2 py-2 text-sm">
          <div className="text-ember-600 dark:text-ember-400">
            Couldn't load this {noun}
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
    </RecordFormModal>
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
  const [model, setModel] = useState("");
  const [category, setCategory] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setManufacturer("");
      setCategory("");
      setModel("");
      setLocationId(null);
    }
  }, [open]);

  const [barcodeMetadata, setBarcodeMetadata] = useState<Record<string, unknown>>({});
  const [barcodeImage, setBarcodeImage] = useState("");
  const barcode = useNewRecordBarcode({ kind: instance ? `${instance}:item` : "assets:asset", metadata: barcodeMetadata, setMetadata: setBarcodeMetadata, natives: [
    { name: "name", label: "Name", key: "title", value: name, setValue: setName },
    { name: "manufacturer", label: "Brand", key: "brand", value: manufacturer, setValue: setManufacturer },
    { name: "model", label: fp.label("model", "Model"), key: "model", value: model, setValue: setModel },
    { name: "category", label: "Category", key: "category", value: category, setValue: setCategory },
    { name: "image_path", label: "Photo", key: "image_url", value: barcodeImage, setValue: setBarcodeImage },
  ] });
  useEffect(() => { if (open) { setBarcodeMetadata({}); setBarcodeImage(""); } }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createAsset(activeSlug, {
        name: name.trim(),
        metadata: barcodeMetadata,
        image_path: barcodeImage || null,
        manufacturer: manufacturer.trim() || null,
        model: model.trim() || null,
        type: category.trim() || null,
        location_id: locationId,
      }, instance),
    onSuccess: (a) => {
      toast.success(`${noun[0]!.toUpperCase()}${noun.slice(1)} added.`);
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
      onClose();
      // On an instance page stay in the instance and deep-link the new record's
      // detail; on the base page go to /assets/:id as before.
      navigate(resolveDetailPath({ kind: "assets:asset", id: a.id, instance: instance ?? null, detailUrl: null, baseDetailRoute: "/assets/{id}" }) ?? "/assets");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || barcode.blocked) return;
    create.mutate();
  }

  return (
    <RecordFormModal open={open} onClose={onClose} title={`New ${noun}`}>
      <form onSubmit={submit} className="space-y-3">
        {barcode.controls}
        {barcodeImage && <div className="flex items-center gap-2"><EntityThumb src={barcodeImage} alt="Photo from barcode" size={96} /><button type="button" className="text-sm text-accent underline" onClick={() => setBarcodeImage("")}>Remove photo</button></div>}
        <label className="block">
          <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
        </label>
        <FieldPack items={[
          {
            need: fieldNeed("model", { control: "text", label: fp.label("model", "Model") }),
            node: <label className="block"><span className="block text-sm mb-1">{fp.label("model", "Model")}</span><input className="input" value={model} onChange={(e) => setModel(e.target.value)} /></label>,
          },
          {
            need: fieldNeed("manufacturer", { control: "text", label: fp.label("manufacturer", "Manufacturer") }),
            node: (
              <div className="block">
                <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{fp.label("manufacturer", "Manufacturer")}</span>
                <UsedValueInput kind={instance ? `${instance}:item` : ENTITY_KIND} field="manufacturer" label={fp.label("manufacturer", "Manufacturer")} value={manufacturer} onCommit={(v) => setManufacturer(v ?? "")} live />
              </div>
            ),
          },
          {
            need: fieldNeed("category", { control: "text", label: "Type / category" }),
            node: (
              <label className="block">
                <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Type / category</span>
                <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder='e.g. "Appliance", "Hand tool"' className="input" />
              </label>
            ),
          },
          {
            need: fieldNeed("location", { control: "picker", label: "Location" }),
            node: (
              <LocationTreePicker
                label="Location"
                value={locationId}
                onChange={setLocationId}
              />
            ),
          },
        ]} />
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line dark:border-slate-700">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || create.isPending || barcode.blocked} className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </RecordFormModal>
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
    <label className="block min-w-0">
      <span className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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
