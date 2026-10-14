import { totalLabel } from "@cobblr/platform-contract/field-aggregate";
import { normalizeGrouping, type GroupBy } from "@cobblr/platform-contract/grouped-list";
import { centsFromAmount, formatMoney, formatStoredMoney, fieldCurrency, type MoneyStorage } from "@cobblr/platform-contract/money";
// /views — list every saved view, open one to render its data
// through the list resolver. Lets users see what their workspace
// looks like through each lens without leaving the platform UI.
//
// v0.1 renders the 'list' view_type. Future kanban/calendar/table
// renderers swap in here as they ship.

import { useState, useMemo, useEffect, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useKindLabels } from "../lib/useKindLabels";
import { dayHere, dayLabel, daysUntilField } from "@cobblr/platform-contract/day";
import { expiryPhrase, expiryState } from "@cobblr/platform-contract/expiry-grace";
import { tallyCadence, CADENCE_PRESETS } from "../lib/cadence";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useDetailRoute, useListRoute } from "../lib/useDetailRoute";
import { ViewEmptyState } from "../components/ViewEmptyState";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, FileDown, LayoutList, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { WEEKDAYS, MONTHS, isoLocal, buildMonthGrid, shiftMonth } from "../lib/month-grid";
import { useMutation } from "@tanstack/react-query";
import { ApiError, api, type SavedView } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { rovingRadio, ContributedViewToolbar, Modal, useTickedRows, useAskCobbAboutSelection, downloadBlob, useToast, useConfirm, usePageTitle, BulkActionBar, BulkSetField, useFlowHost, EntityPhoto, useRunAction, LOCATION_GROUP_KEY, TILE_GRID, TILE_TITLE, distinctSubtitle, PhoneRecordList, usePhoneLayout } from "@cobblr/platform-web";
import { groupRows, fieldVal, orderedGroups, NO_GROUP, NO_GROUP_LABEL } from "../lib/view-group-key";
import { RowStockProvider, useRowStock } from "../components/ViewRowStock";
import { useAreaResolver } from "../lib/useAreaResolver";
import { useViewData, type ViewData } from "../lib/useViewData";
import { BoardDnd, dayCoordinates, useBoardCard, useBoardColumn } from "../components/views/BoardDrag";
import { GanttBar } from "../components/views/GanttBar";
import { draggedBar, onDay } from "../lib/view-dates";
import { isSettableField, useViewRecordEdit } from "../lib/recordWriter";
import { ViewMore } from "../components/ViewMore";
import {
  useKindFields,
  humanize,
  FieldSelect,
  SortBuilder,
  FilterBuilder,
  ColumnPicker,
  configToFilterRows,
  filterRowsToConfig,
  sortToRows,
  rowsToSort,
  type FilterRow,
  type SortRow,
} from "../components/ViewBuilder";
import { layoutConfig, tableGroupingValue } from "../lib/view-config";

export function ViewsPage() {
  usePageTitle("Views");
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [active, setActive] = useState<SavedView | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SavedView | null>(null);
  const pinToggle = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.updateSavedView(activeSlug, id, { pinned }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["dash-views", activeSlug] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const list = useQuery({
    queryKey: ["saved-views", activeSlug],
    queryFn: () => api.listSavedViews(activeSlug),
    enabled: !!activeSlug,
  });

  const items = list.data?.items ?? [];

  // Deep-link: /views?view=<id> opens that view directly, so a "By category"
  // link elsewhere (e.g. the dashboard widget) lands ON the view instead of the
  // list where you'd have to click it a second time (reported double-hop).
  const [params, setParams] = useSearchParams();
  const viewParam = params.get("view");
  useEffect(() => {
    if (!viewParam || active) return;
    const match = items.find((v) => v.id === viewParam);
    if (match) setActive(match);
  }, [viewParam, items, active]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Views</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} saved
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New view
        </button>
      </div>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No saved views yet. Each module's pages can save their current filters as a view.
        </div>
      )}

      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((v) => (
          <li
            key={v.id}
            className="flex items-center gap-1 sm:gap-3 px-3 py-2 text-sm hover:bg-subtle dark:hover:bg-slate-800/40 cursor-pointer"
            onClick={() => setActive(v)}
          >
            <LayoutList size={14} className="shrink-0 text-faint" />
            {/* The name takes the row's width and wraps rather than cutting
                short; what it shows and how sit on the line under it (#6201:
                with finger-sized actions a phone row left the name a few
                letters). */}
            <div className="min-w-0 flex-1">
              <div className="font-medium break-words">{v.name}</div>
              <div className="text-xs text-muted dark:text-slate-400 break-words">
                {labels.collection(v.entity_kind)} · {labels.viewType(v.view_type)}
                {v.is_default && " · default"}
                {v.owner_user_id === null && " · shared"}
                {v.pinned && " · pinned"}
              </div>
            </div>
            <button
              aria-label={v.pinned ? "Unpin from dashboard" : "Pin to dashboard"}
              onClick={(e) => {
                e.stopPropagation();
                pinToggle.mutate({ id: v.id, pinned: !v.pinned });
              }}
              className={
                "inline-flex shrink-0 min-h-11 min-w-11 -my-2 items-center justify-center " +
                (v.pinned ? "text-accent hover:text-accent" : "text-faint hover:text-accent")
              }
              title={v.pinned ? "Unpin from dashboard" : "Pin to dashboard"}
            >
              {v.pinned ? <Pin size={14} /> : <PinOff size={14} />}
            </button>
            <button
              aria-label="Edit"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(v);
              }}
              className="inline-flex shrink-0 min-h-11 min-w-11 -my-2 items-center justify-center text-faint hover:text-accent"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              aria-label="Delete"
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await confirm({
                  title: "Delete view?",
                  message: v.name,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await api.deleteSavedView(activeSlug, v.id);
                  toast.success("Deleted");
                  void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
                } catch (err) {
                  toast.error(`Delete failed: ${(err as Error).message}`);
                }
              }}
              className="inline-flex shrink-0 min-h-11 min-w-11 -my-2 items-center justify-center text-faint hover:text-ember-500"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      {active && (
        <ViewDataModal
          view={active}
          slug={activeSlug}
          onClose={() => {
            // Clear the deep-link param too — otherwise the open-on-?view effect
            // immediately re-opens the modal and the X appears not to work.
            setActive(null);
            if (viewParam) {
              setParams(
                (p) => {
                  const n = new URLSearchParams(p);
                  n.delete("view");
                  return n;
                },
                { replace: true },
              );
            }
          }}
        />
      )}

      {createOpen && (
        <CreateViewModal
          slug={activeSlug}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
      {editing && (
        <EditViewModal
          slug={activeSlug}
          view={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
            void qc.invalidateQueries({ queryKey: ["view-data", activeSlug] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ViewDataModal({
  view,
  slug,
  onClose,
}: {
  view: SavedView;
  slug: string;
  onClose: () => void;
}) {
  const data = useViewData(slug, view.id, view.entity_kind);

  return (
    <Modal open onClose={onClose} title={view.name} size="lg">
      <SavedViewBody view={view} data={data} />
    </Modal>
  );
}

/** The view as a spreadsheet: its filter, its sort and (a table) its columns,
 *  written by the server as this person reads the collection. */
function ViewExportButton({ slug, viewId, grouped }: { slug: string; viewId: string; grouped?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [subtotals, setSubtotals] = useState(false);
  return (
    <span className="ml-auto inline-flex flex-wrap items-center gap-2">
    {grouped && <label className="inline-flex items-center gap-1"><input type="checkbox" checked={subtotals} onChange={(e) => setSubtotals(e.target.checked)} /> Include subtotals</label>}
    <button
      type="button"
      disabled={busy}
      data-testid="view-export"
      title="Download this view as a spreadsheet (CSV)"
      className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        try {
          const got = await api.exportViewCsv(slug, viewId, subtotals);
          downloadBlob(got.blob, got.filename);
          if (got.secretsOmitted) toast.info("Secret fields were left out.");
          if (got.complete) toast.success("Spreadsheet downloaded.");
          else toast.info("Downloaded the first 5,000. Narrow the view to get the rest.");
        } catch (err) {
          toast.error((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileDown size={12} /> {busy ? "Exporting…" : "Export"}
    </button>
    </span>
  );
}

/** A saved grouping as the words a person reads: "category", "brand, then year". */
function groupingWords(raw: unknown): string {
  const names = (Array.isArray(raw) ? raw : [raw]).map((g) => (typeof g === "string" ? g : (g as { field?: unknown })?.field)).filter((g): g is string => typeof g === "string");
  return names.length ? names.map((n) => `“${humanize(n)}”`).join(", then ") : "its saved column";
}

/** The controls the module owning this view's records contributes to its
 *  header, handed the rows the view shows. Mounted only over rows, so an empty
 *  view never asks whose records it would hold. */
function ViewToolbar({ slug, view, ids }: { slug: string; view: SavedView; ids: string[] }) {
  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), staleTime: 5 * 60_000 });
  const owner = kinds.data?.items.find((k) => k.id === view.entity_kind)?.module_name ?? null;
  return <ContributedViewToolbar module={owner} ctx={{ slug, kind: view.entity_kind, ids, viewName: view.name }} />;
}

/** The type-switched render of one saved view's rows — shared by the config
 *  page's preview modal, the full-page /views/:viewId surface and the
 *  instance page's view tabs. `collectionEmpty` is the server's word on
 *  whether zero rows means an empty collection or a filter that hid it all. */
export function SavedViewBody({
  view,
  data,
}: {
  view: SavedView;
  /** The server's whole answer, never a bare array: a view that counted the
   *  rows it had loaded read "50 3D printers" with 56 on file, so the count
   *  here can only be the collection's `total`. */
  data: ViewData;
}) {
  const { items, isLoading, collectionEmpty, unapplied, ungrouped, total } = data;
  const cfg = (view.config ?? {}) as ViewConfig;
  // Count reads in the collection's own noun ("5 books"), not DB-speak "5
  // rows" and not the kind's literal suffix ("5 items" about books).
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const noun = labels.noun(view.entity_kind);
  const plural = labels.plural(view.entity_kind);
  // The kind's own list page carries its create form (`?new=1` opens it) and
  // shows everything (`?view=table` on an instance page, this once).
  const listRoute = useListRoute(activeSlug)(view.entity_kind);
  // Which module owns the view's records: its toolbar controls come with them.
  // Bulk select (table view): pick rows → open the organize planner over them.
  // Generic — the planner files whatever the kind's writer accepts a location on;
  // a non-locatable kind just yields nothing to file.
  const { openFlow } = useFlowHost();
  const [selected, setSelected] = useTickedRows(isLoading ? null : items.map((r) => r.id), view.id);
  // The rows a view shows are records of its kind: ticked, they are what Cobb
  // is talking about, as on the kind's own list.
  const askCobb = useAskCobbAboutSelection(selected, items, view.entity_kind, noun);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div className="space-y-2">
      {/* The collection's name and a plain view word. The kind id and the
          renderer id used to print here as chips; they are routing keys, not
          words a person uses (2026-09-12). */}
      <div className="text-xs text-muted dark:text-slate-400 flex flex-wrap items-center gap-2">
        <span>{labels.collection(view.entity_kind)}</span>
        <span className="px-1.5 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300 text-[10px]" data-testid="view-kind-word">
          <ViewKindWord slug={activeSlug} view={view} fallback={labels.viewType(view.view_type)} ungrouped={!!ungrouped} />
        </span>
        <span data-testid="view-count">
          {total === null ? `${items.length}+` : total} {(total ?? items.length) === 1 ? noun : plural}
        </span>
        {items.length > 0 && <ViewExportButton slug={activeSlug} viewId={view.id} grouped={!!data.groups} />}
        {/* What the module that owns these records puts on its views (inventory's
            What's still here?); this page names no contributor. */}
        {items.length > 0 && <ViewToolbar slug={activeSlug} view={view} ids={items.map((r) => r.id)} />}
      </div>
      {/* A filter the collection could not run used to vanish, so the rows
          below read as the filtered set when they were everything. */}
      {unapplied && unapplied.length > 0 && (
        <p data-testid="view-unapplied" className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-xs text-amber-900 dark:text-amber-200">
          {unapplied.length === 1 ? "One filter" : `${unapplied.length} filters`} in this view could not run, so these are not narrowed by{" "}
          {unapplied.map((p) => `${p.col} ${p.op} ${p.ref_col ?? String(p.value ?? "")}`).join(", ")}.
        </p>
      )}
      {ungrouped && (
        <p data-testid="view-ungrouped" className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-xs text-amber-900 dark:text-amber-200">
          This view could not group by {groupingWords(ungrouped.group_by)}, so these are in one list. Edit the view to choose another column.
        </p>
      )}
      {data.isError && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">This view could not load. <button onClick={data.refetch}>Try again</button></p>}
      {isLoading && <div className="text-sm text-muted">Loading…</div>}
      {/* Before the renderer switch, so no renderer can ship without it. */}
      {items.length === 0 && !isLoading && (
        <ViewEmptyState
          noun={noun}
          plural={plural}
          collectionEmpty={collectionEmpty}
          createTo={listRoute ? `${listRoute}?new=1` : null}
          seeAllTo={listRoute ? `${listRoute}?view=table` : null}
        />
      )}
      {/* Every view of a counted collection steps its rows' counts (#3884).
          Mounted only with rows to step: an empty view asks nothing. */}
      {items.length > 0 && (
      <RowStockProvider slug={activeSlug} kind={view.entity_kind}>
      {items.length > 0 && view.view_type === "kanban" && (
        <KanbanRenderer slug={activeSlug} kind={view.entity_kind} items={items} groupBy={cfg.group_by ?? "subtitle"} />
      )}
      {items.length > 0 && view.view_type === "table" && (data.groups ? <GroupedTableRenderer view={view} data={data} slug={activeSlug} selection={{ selected, toggle }} /> :
        <TableRenderer
          slug={activeSlug}
          kind={view.entity_kind}
          items={items}
          columns={cfg.visible_fields}
          selection={{ selected, toggle }}
        />
      )}
      {view.view_type === "table" && selected.size > 0 && (
        <BulkActionBar
        records={{ kind: view.entity_kind, ids: Array.from(selected) }}
          count={selected.size}
          onClear={() => setSelected(new Set())}
          onAskCobb={askCobb ?? undefined}
          actions={
            <>
            <BulkSetField records={Array.from(selected).map((id) => ({ kind: view.entity_kind, id }))} onDone={() => setSelected(new Set())} />
            <button
              onClick={() => {
                openFlow("core-scan:organize", {
                  scope: "refs",
                  refs: [...selected].map((rowId) => `${view.entity_kind}::${rowId}`),
                });
                setSelected(new Set());
              }}
              className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1 text-sm transition"
            >
              Organize selected
            </button>
            </>
          }
        />
      )}
      {items.length > 0 && view.view_type === "trend" && (
        <TrendRenderer items={items} cfg={cfg} />
      )}
      {items.length > 0 && view.view_type === "calendar" && (
        <CalendarRenderer slug={activeSlug} kind={view.entity_kind} items={items} cfg={cfg} />
      )}
      {items.length > 0 && view.view_type === "gantt" && (
        <GanttRenderer slug={activeSlug} kind={view.entity_kind} items={items} cfg={cfg} />
      )}
      {items.length > 0 && view.view_type === "gallery" && (
        <GalleryRenderer items={items} cfg={cfg} />
      )}
      {items.length > 0 && view.view_type === "heatmap" && (
        <HeatmapRenderer items={items} cfg={cfg} />
      )}
      {items.length > 0 && view.view_type === "vending" && (
        <VendingRenderer items={items} cfg={cfg} />
      )}
      {items.length > 0 && view.view_type !== "kanban" && view.view_type !== "table" && view.view_type !== "trend" && view.view_type !== "calendar" && view.view_type !== "gantt" && view.view_type !== "gallery" && view.view_type !== "heatmap" && view.view_type !== "vending" && (
        <ListRenderer items={items} />
      )}
      </RowStockProvider>
      )}
      {/* Past the server's walk (thousands of records) the rest is paged in
          here, visibly: a view never passes a page off as the whole. */}
      <ViewMore data={data} />
    </div>
  );
}

export function GroupTableFlow({ args, onClose }: { args: Record<string, unknown>; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return <CreateViewModal slug={activeSlug} initialKind={String(args.kind)} initialTable onClose={onClose} onCreated={(id) => {
    void qc.invalidateQueries({ queryKey: ["saved-views", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["inv-saved-views", activeSlug] });
    onClose();
    navigate(`/views/${id}`);
  }} />;
}

function TableGrouping({ fields, value, onChange }: { fields: import("../components/ViewBuilder").KindField[]; value: GroupBy[]; onChange: (groups: GroupBy[]) => void }) {
  const usable = [...fields, ...(fields.some((f) => f.name === "location_name") ? [{ name: "location", label: "Room", type: "text" }] : [])].filter((f) => ["text", "select", "relation", "boolean", "date", "datetime", "string", "enum", "entity"].includes(f.type));
  return <div className="space-y-2">
    {[0, 1].map((i) => <div key={i} className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1"><span className="block text-xs text-muted mb-1">{i === 0 ? "Group by" : "Then by"}</span>
        <FieldSelect fields={usable.filter((f) => f.name !== value[1 - i]?.field)} value={value[i]?.field ?? ""} allowBlank blankLabel="No grouping" onChange={(field) => {
          const next = [...value];
          if (!field) next.splice(i);
          else next[i] = { field, ...(["date", "datetime"].includes(fields.find((f) => f.name === field)?.type ?? "") ? { bucket: "month" as const } : {}) };
          onChange(next.filter(Boolean));
        }} />
      </label>
      {value[i] && ["date", "datetime"].includes(fields.find((f) => f.name === value[i]!.field)?.type ?? "") && <label>
        <span className="block text-xs text-muted mb-1">Date bucket</span>
        <select aria-label={`${i === 0 ? "First" : "Second"} date bucket`} className="rounded border border-line bg-surface px-2 py-1 text-sm" value={value[i]?.bucket ?? "month"} onChange={(e) => onChange(value.map((g, n) => n === i ? { ...g, bucket: e.target.value as GroupBy["bucket"] } : g))}>
          <option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option>
        </select>
      </label>}
    </div>)}
  </div>;
}

// A group's summary totals the columns the view shows, and only what adds up
// (#5079): the server leaves out a field that does not, and a per-unit column
// (length per ball, price each) comes back as value x quantity, named as the
// total it is. Columns the view does not show (a stash's Spare and Installed
// counts) are not summarised.
// The word beside a view's count. A grouped table says what it is grouped by,
// not "Table": beside a "By weight" tab, "Table" read as the other tab (#5079).
// One the server could not apply is not what the rows are.
function ViewKindWord({ slug, view, fallback, ungrouped }: { slug: string; view: SavedView; fallback: string; ungrouped?: boolean }) {
  const by = ungrouped ? [] : normalizeGrouping(view.config?.group_by);
  return by.length ? <GroupedByWord slug={slug} kind={view.entity_kind} fields={by.map((g) => g.field)} /> : <>{fallback}</>;
}

function GroupedByWord({ slug, kind, fields: by }: { slug: string; kind: string; fields: string[] }) {
  const fields = useKindFields(slug, kind);
  return <>Grouped by {by.map((name) => fields.find((f) => f.name === name)?.label ?? humanize(name)).join(", then ")}</>;
}

function GroupTotals({ totals, fields, columns, weightedBy }: { totals: NonNullable<ViewData["totals"]>; fields: import("../components/ViewBuilder").KindField[]; columns: string[]; weightedBy?: ViewData["weightedBy"] }) {
  const label = (name: string) => {
    const own = fields.find((f) => f.name === name)?.label ?? humanize(name);
    return weightedBy?.[name] ? totalLabel(own) : own;
  };
  return <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted" data-testid="group-totals">
    {Object.entries(totals).filter(([name]) => columns.includes(name)).map(([name, amounts]) => <span key={name}>{label(name)}: {amounts.map((a) => a.currency ? formatMoney(centsFromAmount(a.value), { currency: a.currency }) : a.value.toLocaleString()).join(" · ")}</span>)}
  </span>;
}

function GroupedTableRenderer({ view, data, slug, selection }: { view: SavedView; data: ViewData; slug: string; selection: { selected: Set<string>; toggle: (id: string) => void } }) {
  const fields = useKindFields(slug, view.entity_kind);
  // A phone's row steps its count the way the desktop table does, so "2 balls"
  // reads the same at both widths (#5079).
  const stock = useRowStock();
  const by = normalizeGrouping(view.config?.group_by);
  const columns = (view.config?.visible_fields as string[] | undefined) ?? ["title", "subtitle"];
  const groups = data.groups ?? [];
  const rowsById = new Map(data.items.map((r) => [r.id, r]));
  const title = (g: (typeof groups)[number]) => {
    const key = g.keys[g.keys.length - 1];
    if (key === null) return "Not set";
    const field = by[g.keys.length - 1]?.field ?? "";
    const row = data.items.find((r) => g.item_ids.includes(r.id) || String(r.fields[field] ?? (r.fields.metadata as Record<string, unknown> | undefined)?.[field]) === key);
    const label = row ? fieldVal(row.fields, `${field}_label`) : undefined;
    if (label) return String(label);
    return key === "true" ? "Yes" : key === "false" ? "No" : key;
  };
  const render = (g: (typeof groups)[number]): ReactNode => {
    const key = JSON.stringify(g.keys);
    const leaf = g.keys.length === by.length;
    const rows = g.item_ids.map((id) => rowsById.get(id)).filter((r): r is (typeof data.items)[number] => !!r);
    const children = groups.filter((c) => c.keys.length === g.keys.length + 1 && g.keys.every((v, i) => c.keys[i] === v));
    return <details key={key} open className="min-w-0 rounded border border-line dark:border-slate-700" data-testid="table-group">
      <summary className="cursor-pointer rounded bg-subtle px-3 py-2">
        <span className="font-medium">{title(g)}</span> <span className="text-xs text-muted">· {g.count}</span>
        <GroupTotals totals={g.totals} fields={fields} columns={columns} weightedBy={data.weightedBy} />
      </summary>
      <div className="min-w-0 space-y-2 p-2">
        {!leaf && children.map(render)}
        {leaf && <>
          <div className="hidden sm:block"><TableRenderer slug={slug} kind={view.entity_kind} items={rows} columns={columns} selection={selection} layout="table" /></div>
          <div className="divide-y divide-line sm:hidden">{rows.map((r) => <div key={r.id} className="min-w-0 py-2">
            <div className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={selection.selected.has(r.id)} onChange={() => selection.toggle(r.id)} aria-label={`Select ${r.title}`} /><RecordLink row={r} className="min-w-0 break-words font-medium">{r.title}</RecordLink></div>
            {columns.includes("subtitle") && r.subtitle && <p className="ml-6 break-words text-xs text-muted">{r.subtitle}</p>}
            <dl className="ml-6 space-y-1 text-xs">{columns.filter((c) => c !== "title" && c !== "subtitle").map((c) => <div key={c} className="flex min-w-0 flex-wrap gap-x-2"><dt className="text-muted">{fields.find((f) => f.name === c)?.label ?? humanize(c)}</dt><dd className="min-w-0 break-words">{c === "qty" && stock.on ? stock.stepper(r) ?? formatCell(c, r, fields.find((f) => f.name === c)?.money) : formatCell(c, r, fields.find((f) => f.name === c)?.money)}</dd></div>)}</dl>
          </div>)}</div>
          {g.item_ids.length < g.count && <button className="rounded border border-line px-3 py-1 text-sm" disabled={!!data.loadingGroup} onClick={() => data.loadGroup?.(g.keys, g.item_ids.length)}>{data.loadingGroup === key ? "Loading…" : `Show more (${g.item_ids.length} of ${g.count})`}</button>}
        </>}
      </div>
    </details>;
  };
  return <div className="min-w-0 space-y-2">
    {groups.filter((g) => g.keys.length === 1).map(render)}
    <div className="rounded border border-line p-3" data-testid="table-grand-total"><strong className="text-sm">Grand total · {data.total}</strong><GroupTotals totals={data.totals ?? {}} fields={fields} columns={columns} weightedBy={data.weightedBy} /></div>
  </div>;
}

interface ViewConfig {
  group_by?: string;
  visible_fields?: string[];
  [k: string]: unknown;
}

interface ViewRow {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  fields?: Record<string, unknown>;
}

// Trend renderer — a dependency-free SVG line chart for time-series rows
// (tracking measurements, or any kind with a numeric value + a date).
// Reads cfg.x (date field, default "measured_at"), cfg.y (numeric field,
// default "value"), and optional cfg.goal (a horizontal target line). No
// charting library — a small inline SVG keeps the web bundle dep-free.
function TrendRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const xField = (cfg.x as string) ?? "measured_at";
  const yField = (cfg.y as string) ?? "value";
  const goal = typeof cfg.goal === "number" ? cfg.goal : undefined;

  const pts = items
    .map((r) => {
      const t = new Date(String(fieldVal(r.fields, xField) ?? "")).getTime();
      const v = Number(fieldVal(r.fields, yField));
      return Number.isFinite(t) && Number.isFinite(v) ? { t, v } : null;
    })
    .filter((p): p is { t: number; v: number } => p !== null)
    .sort((a, b) => a.t - b.t);

  if (pts.length < 2) {
    return <div className="text-sm text-muted italic">Need at least two data points to chart a trend.</div>;
  }

  const W = 560, H = 220, PAD = 28;
  const ts = pts.map((p) => p.t), vs = pts.map((p) => p.v);
  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  let vMin = Math.min(...vs, ...(goal != null ? [goal] : []));
  let vMax = Math.max(...vs, ...(goal != null ? [goal] : []));
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const x = (t: number) => PAD + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - vMin) / (vMax - vMin || 1)) * (H - 2 * PAD);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const latest = pts[pts.length - 1]!.v;

  return (
    <div className="border border-line dark:border-slate-700 rounded p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Trend chart">
        {/* axes */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={1} />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth={1} />
        {/* goal line */}
        {goal != null && (
          <>
            <line x1={PAD} y1={y(goal)} x2={W - PAD} y2={y(goal)} className="stroke-emerald-500" strokeWidth={1} strokeDasharray="4 3" />
            <text x={W - PAD} y={y(goal) - 4} textAnchor="end" className="fill-emerald-600 text-[10px]">goal {goal}</text>
          </>
        )}
        {/* the trend line */}
        <path d={path} fill="none" className="stroke-cobble-500" strokeWidth={2} />
        {/* points */}
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.5} className="fill-cobble-600" />
        ))}
        {/* latest value label */}
        <text x={x(pts[pts.length - 1]!.t)} y={y(latest) - 6} textAnchor="end" className="fill-slate-600 dark:fill-slate-300 text-[10px]">{latest}</text>
      </svg>
      <div className="text-xs text-muted px-1 flex justify-between">
        <span>{new Date(tMin).toLocaleDateString()}</span>
        <span>latest: <b>{latest}</b>{goal != null ? ` · goal ${goal}` : ""}</span>
        <span>{new Date(tMax).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

// Calendar renderer — places each row on a month grid by its date field.
// cfg.date_field names the field (a top-level native or a custom metadata
// field, read via fieldVal); values are YYYY-MM-DD (or an ISO datetime,
// sliced). cfg.title_field overrides what's shown on the chip (default title).
export function CalendarRenderer({ slug, kind, items, cfg }: { slug: string; kind: string; items: ViewRow[]; cfg: ViewConfig }) {
  const dateField = (cfg.date_field as string) || "due_date";
  const titleField = (cfg.title_field as string) || "title";
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [openDay, setOpenDay] = useState<string | null>(null);
  const { weeks } = useMemo(() => buildMonthGrid(cursor.y, cursor.m), [cursor]);

  const byDay = useMemo(() => {
    const m: Record<string, ViewRow[]> = {};
    for (const it of items) {
      const dv = fieldVal(it.fields, dateField);
      if (dv == null || dv === "") continue;
      const key = String(dv).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      (m[key] ||= []).push(it);
    }
    return m;
  }, [items, dateField, titleField]);

  const cellTitle = (r: ViewRow): string => {
    if (titleField === "title") return r.title;
    if (titleField === "subtitle") return r.subtitle ?? r.title;
    const v = fieldVal(r.fields, titleField);
    return v == null ? r.title : String(v);
  };

  // An entry moves to another day by dragging it there (#4173), when its
  // kind has a writer and the date is one a person sets (not created_at).
  const { edit, writable } = useViewRecordEdit(slug);
  const dateDef = useKindFields(slug, kind).find((f) => f.name === dateField);
  const movable = writable(kind) && isSettableField(dateDef);
  const moveTo = (row: { kind: string; id: string; title: string }, day: string) => {
    const full = items.find((r) => r.kind === row.kind && r.id === row.id);
    const current = full ? fieldVal(full.fields, dateField) : null;
    if (String(current ?? "").slice(0, 10) === day) return;
    void edit(row, { [dateField]: onDay(current, day) }, `${row.title} is on ${dayWords(day)} now`);
  };

  const placed = Object.values(byDay).reduce((n, a) => n + a.length, 0);
  const todayKey = isoLocal(new Date());
  const monthDays = Object.keys(byDay)
    .filter((k) => k.startsWith(`${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-`))
    .sort();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => setCursor((c) => shiftMonth(c, -1))} className="p-1 rounded hover:bg-subtle dark:hover:bg-slate-800 transition" title="Previous month" aria-label="Previous month"><ChevronLeft size={16} /></button>
        <span className="text-sm font-medium text-content dark:text-mortar-100 min-w-[9rem] text-center">{MONTHS[cursor.m]} {cursor.y}</span>
        <button onClick={() => setCursor((c) => shiftMonth(c, 1))} className="p-1 rounded hover:bg-subtle dark:hover:bg-slate-800 transition" title="Next month" aria-label="Next month"><ChevronRight size={16} /></button>
        <button onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }} className="ml-1 text-[10px] uppercase tracking-widest text-accent hover:underline">today</button>
        <div className="flex-1" />
        <span className="hidden sm:inline text-[10px] font-mono text-faint dark:text-slate-500">on <code>{dateField}</code> · {placed} of {items.length}</span>
      </div>

      {/* A phone: the month as a list of the days that have something on them.
          A seven-column grid at 390 px is seven 50 px cells with the titles
          cut to three letters (#4173). */}
      <div className="sm:hidden" data-testid="calendar-agenda">
        {monthDays.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line dark:border-slate-700 p-4 text-center text-sm text-muted dark:text-slate-400">Nothing on the calendar in {MONTHS[cursor.m]}.</p>
        ) : (
          <ol className="space-y-3">
            {monthDays.map((key) => (
              <li key={key}>
                <h3 className={"text-xs font-medium mb-1 " + (key === todayKey ? "text-accent" : "text-muted dark:text-slate-400")}>
                  {dayWords(key)}
                  {key === todayKey ? " · today" : ""}
                </h3>
                <ul className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-800">
                  {byDay[key]!.map((r) => (
                    <li key={`${r.kind}:${r.id}`} className="px-3 py-2 text-sm">
                      <RecordLink row={r} card className="block truncate text-content dark:text-mortar-100 hover:text-accent">{cellTitle(r)}</RecordLink>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="hidden sm:block rounded-xl border border-line dark:border-slate-700 overflow-hidden">
        <BoardDnd enabled={movable} label={dayWords} keys={dayCoordinates} onMove={moveTo}>
          <div className="grid grid-cols-7 bg-subtle/60 dark:bg-slate-800/40 border-b border-line dark:border-slate-700">
            {WEEKDAYS.map((w) => (
              <div key={w} className="px-2 py-1 text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 text-center">{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {weeks.flat().map((day) => {
              const key = isoLocal(day);
              const inMonth = day.getMonth() === cursor.m;
              const dayRows = byDay[key] ?? [];
              return (
                <CalendarDay key={key} day={key} droppable={movable} inMonth={inMonth}>
                  <div className={"text-[11px] font-mono mb-0.5 px-1 " + (key === todayKey ? "inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white" : inMonth ? "text-content dark:text-mortar-200" : "text-faint dark:text-slate-600")}>{day.getDate()}</div>
                  <div className="space-y-0.5">
                    {dayRows.slice(0, 4).map((r) => (
                      <CalendarEntry key={`${r.kind}:${r.id}`} row={r} day={key}>
                        <RecordLink row={r} card className="block truncate rounded px-1 py-0.5 text-[10px] leading-tight bg-cobble-100 text-accent dark:bg-cobble-900/40 dark:text-cobble-200 hover:underline">{cellTitle(r)}</RecordLink>
                      </CalendarEntry>
                    ))}
                    {dayRows.length > 4 && (
                      <button type="button" onClick={() => setOpenDay(key)} className="text-[10px] text-accent hover:underline px-1">
                        +{dayRows.length - 4} more
                      </button>
                    )}
                  </div>
                </CalendarDay>
              );
            })}
          </div>
        </BoardDnd>
      </div>

      <Modal open={openDay !== null} onClose={() => setOpenDay(null)} title={openDay ? dayWords(openDay) : ""} size="sm">
        <ul className="divide-y divide-line dark:divide-slate-800">
          {(openDay ? byDay[openDay] ?? [] : []).map((r) => (
            <li key={`${r.kind}:${r.id}`} className="py-2 text-sm">
              <RecordLink row={r} card className="block truncate text-content dark:text-mortar-100 hover:text-accent">{cellTitle(r)}</RecordLink>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

/** "Tue 29 Sep" for a day key. */
function dayWords(key: string): string {
  return dayLabel(key, { weekday: "short", day: "numeric", month: "short" });
}

function CalendarDay({ day, droppable, inMonth, children }: { day: string; droppable: boolean; inMonth: boolean; children: ReactNode }) {
  const drop = useBoardColumn(day);
  return (
    <div
      ref={droppable ? drop.ref : undefined}
      data-day={day}
      className={
        "min-h-[4.5rem] border-b border-r border-line dark:border-slate-800 p-1 transition-colors " +
        (drop.over && droppable ? "bg-accent/10 " : inMonth ? "bg-white dark:bg-slate-950 " : "bg-mortar-50/40 dark:bg-slate-900/40 ")
      }
    >
      {children}
    </div>
  );
}

function CalendarEntry({ row, day, children }: { row: ViewRow; day: string; children: ReactNode }) {
  const drag = useBoardCard(row, day);
  return (
    <div
      ref={drag.enabled ? drag.ref : undefined}
      {...drag.props}
      style={drag.style}
      data-calendar-entry=""
      // A link is natively draggable; the browser's own drag would take the
      // gesture from the calendar's.
      onDragStart={(e) => e.preventDefault()}
      className={drag.dragging ? "shadow-lg ring-2 ring-accent rounded" : undefined}
    >
      {children}
    </div>
  );
}

// Gantt renderer — a horizontal timeline: each row is a bar from its start
// date (cfg.start_field, default "start_date") to its end date (cfg.end_field,
// default "target_date"). The axis spans the earliest start → latest end across
// all rows. A row missing a start is dropped; a row missing an end renders as a
// short milestone bar on its start day. cfg.title_field overrides the left-rail
// label. Dependency-free — plain divs positioned by percentage.
export function GanttRenderer({ slug, kind, items, cfg }: { slug: string; kind: string; items: ViewRow[]; cfg: ViewConfig }) {
  const startField = (cfg.start_field as string) || "start_date";
  const endField = (cfg.end_field as string) || "target_date";
  const titleField = (cfg.title_field as string) || "title";

  const day = 86400000;
  const parseDay = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const t = new Date(`${String(v).slice(0, 10)}T00:00:00`).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const rowTitle = (r: ViewRow): string => {
    if (titleField === "title") return r.title;
    if (titleField === "subtitle") return r.subtitle ?? r.title;
    const v = fieldVal(r.fields, titleField);
    return v == null ? r.title : String(v);
  };

  const bars = useMemo(() => {
    const out: { r: ViewRow; start: number; end: number; milestone: boolean }[] = [];
    for (const r of items) {
      const start = parseDay(fieldVal(r.fields, startField));
      if (start == null) continue;
      const rawEnd = parseDay(fieldVal(r.fields, endField));
      const milestone = rawEnd == null || rawEnd < start;
      out.push({ r, start, end: milestone ? start : rawEnd!, milestone });
    }
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }, [items, startField, endField]);

  // Bars drag and stretch (#4173) when the kind has a writer and both dates
  // are ones a person sets.
  const { edit, writable } = useViewRecordEdit(slug);
  const kindFields = useKindFields(slug, kind);
  const editable =
    writable(kind) && isSettableField(kindFields.find((f) => f.name === startField)) && isSettableField(kindFields.find((f) => f.name === endField));
  const commit = (r: ViewRow, days: number, mode: "move" | "resize") => {
    if (days === 0) return;
    const next = draggedBar({ start: fieldVal(r.fields, startField), end: fieldVal(r.fields, endField) }, days, mode);
    const changes: Record<string, unknown> = mode === "move" ? { [startField]: next.start, ...(next.end ? { [endField]: next.end } : {}) } : { [endField]: next.end };
    const when = mode === "move" ? `starts ${dayWords(String(next.start).slice(0, 10))}` : `ends ${dayWords(String(next.end).slice(0, 10))}`;
    void edit({ kind: r.kind, id: r.id, title: rowTitle(r) }, changes, `${rowTitle(r)} ${when} now`);
  };

  if (bars.length === 0) {
    return (
      <div className="text-sm text-muted italic">
        No rows with a <code>{startField}</code> date to lay out on a timeline.
      </div>
    );
  }

  const axisMin = Math.min(...bars.map((b) => b.start));
  const axisMaxRaw = Math.max(...bars.map((b) => b.end));
  // Pad the right edge by a day so a same-day milestone/end isn't a zero-width sliver.
  const axisMax = axisMaxRaw + day;
  const span = axisMax - axisMin || day;
  const pct = (t: number) => ((t - axisMin) / span) * 100;
  const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // Month boundary tick lines across the track for visual context.
  const ticks: number[] = [];
  {
    const d = new Date(axisMin);
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    while (d.getTime() < axisMax) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + 1);
    }
  }
  const todayT = parseDay(isoLocal(new Date()));
  // The names column: narrower on a phone, where it shares 390 px with the
  // timeline it pins over.
  const RAIL = "w-[7.5rem] sm:w-40";
  const spanDays = span / day;
  // On a narrow screen the timeline keeps a readable width per day and
  // scrolls sideways under a pinned column of names (#4173), instead of
  // squeezing months into 200 px.
  const trackMin = Math.round(spanDays * 24);

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono text-faint dark:text-slate-500 flex justify-between px-1">
        <span><code>{startField}</code> → <code>{endField}</code> · {bars.length} of {items.length}</span>
        <span>{fmt(axisMin)} – {fmt(axisMaxRaw)}</span>
      </div>
      <div className="border border-line dark:border-slate-700 rounded overflow-x-auto" data-testid="gantt-scroll">
        <div style={{ ["--gantt-min" as string]: `calc(7.5rem + ${trackMin}px)` }} className="min-w-[var(--gantt-min)] sm:min-w-0">
        {bars.map((b, i) => (
          <RecordCard
            key={`${b.r.kind}:${b.r.id}`}
            row={b.r}
            className={"flex items-stretch " + (i % 2 ? "bg-subtle/40 dark:bg-slate-900/40" : "bg-surface dark:bg-slate-950")}
          >
            <div
              className={`${RAIL} ` + "sticky left-0 z-10 shrink-0 px-2 py-1.5 text-xs text-content dark:text-mortar-200 truncate border-r border-line dark:border-slate-800 " + (i % 2 ? "bg-subtle dark:bg-slate-900" : "bg-surface dark:bg-slate-950")}
              title={rowTitle(b.r)}
            >
              <RecordLink row={b.r} className="hover:text-accent hover:underline">{rowTitle(b.r)}</RecordLink>
            </div>
            <div className="relative flex-1 my-1 mx-2">
              {/* month tick lines */}
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 bottom-0 w-px bg-line/70 dark:bg-slate-800" style={{ left: `${pct(t)}%` }} />
              ))}
              {/* today marker */}
              {todayT != null && todayT >= axisMin && todayT <= axisMax && (
                <div className="absolute top-0 bottom-0 w-px bg-accent/60" style={{ left: `${pct(todayT)}%` }} title="today" />
              )}
              {/* the bar */}
              <GanttBar
                left={pct(b.start)}
                width={Math.max(pct(b.end) - pct(b.start), b.milestone ? 0 : 1)}
                milestone={b.milestone}
                perDay={100 / spanDays}
                spanDays={spanDays}
                editable={editable}
                label={`${rowTitle(b.r)}: ${fmt(b.start)}${b.milestone ? " (milestone)" : ` – ${fmt(b.end)}`}`}
                onCommit={(days, mode) => commit(b.r, days, mode)}
              />
            </div>
          </RecordCard>
        ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] font-mono text-faint dark:text-slate-500 px-1">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm bg-cobble-500" /> span (start → end)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm bg-amber-400" /> milestone (no end / end ≤ start)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-px h-3 bg-accent/60" /> today</span>
      </div>
    </div>
  );
}

/** Whatever a renderer draws for one record (a title, a cover tile, a day's
 *  entry, a bar's label) opens that record, when its kind has a detail page
 *  (the entity-kinds registry); plain otherwise. Every renderer routes the
 *  thing a person taps through this: the cover wall drew tiles that opened
 *  nothing, so a book was only reachable from the Table tab (#3583), and the
 *  table, calendar and gantt had the same gap
 *  (every-row-a-view-draws-opens-its-record.test.tsx). */
function RecordLink({
  row,
  className,
  children,
  card,
  "data-testid": testId,
}: {
  row: ViewRow;
  className?: string;
  children: ReactNode;
  /** The link IS the whole card (a cover tile, a calendar entry). */
  card?: boolean;
  "data-testid"?: string;
}) {
  const { activeSlug } = useActiveOrg();
  const routeFor = useDetailRoute(activeSlug);
  const href = routeFor(row.kind, row.id, (row as { detailUrl?: string | null }).detailUrl);
  const cardMark = card ? { "data-record-card": "" } : {};
  if (!href) return <span data-testid={testId} className={className} {...cardMark}>{children}</span>;
  return (
    <Link to={href} data-testid={testId} className={className} {...cardMark}>
      {children}
    </Link>
  );
}

/** A card a renderer draws for one record (a slot on the vending wall, a
 *  board card, a list or table row, a gantt row) opens that record from
 *  anywhere on it, the way a phone is held: on the wall only the photo and the
 *  name were links, so a tap on the count or the empty middle of the card did
 *  nothing (#3868). The card's own controls (the steppers, a checkbox, a link
 *  inside it) keep their tap. The title link stays the door for the keyboard;
 *  the card itself is not a second tab stop. */
function RecordCard({
  row,
  as = "div",
  className,
  children,
  "data-testid": testId,
  dragRef,
  dragProps,
  style,
}: {
  row: ViewRow;
  as?: "div" | "li" | "tr";
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
  /** A view that lets the card be dragged (a board) hands its handle here. */
  dragRef?: (el: HTMLElement | null) => void;
  dragProps?: Record<string, unknown>;
  style?: CSSProperties;
}) {
  const { activeSlug } = useActiveOrg();
  const routeFor = useDetailRoute(activeSlug);
  const navigate = useNavigate();
  const href = routeFor(row.kind, row.id, (row as { detailUrl?: string | null }).detailUrl);
  const Tag = as;
  return (
    <Tag
      ref={dragRef as never}
      {...(dragProps ?? {})}
      style={style}
      data-record-card=""
      data-testid={testId}
      className={(className ?? "") + (href ? " cursor-pointer" : "")}
      onClick={(e: MouseEvent<HTMLElement>) => {
        if (!href || e.defaultPrevented) return;
        const own = (e.target as HTMLElement).closest("a, button, input, select, textarea, label, [role='button']");
        if (own && e.currentTarget.contains(own)) return;
        navigate(href);
      }}
    >
      {children}
    </Tag>
  );
}

/** A row/card title that links to the record: RecordLink over its title. */
function EntityTitleLink({ row, className }: { row: ViewRow; className?: string }) {
  return (
    <RecordLink row={row} className={`${className ?? ""} hover:text-accent hover:underline`}>
      {row.title}
    </RecordLink>
  );
}

// Vending-machine renderer — the pantry as a wall of slots you read at a glance.
//
// Glanceability over density: quantity as a badge, freshness as one coloured
// dot, and an empty slot that LOOKS empty. Someone standing in the kitchen
// should answer "do we have any?" without parsing a table.
//
// Generic on purpose: the quantity / expiry / reorder-level fields are read by
// name from cfg (defaults suit the Groceries bundle), so the same renderer
// serves a filament shelf or a medicine cabinet. Nothing here knows about food.
function VendingRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const c = cfg as unknown as { qty_field?: string; expiry_field?: string; min_qty_field?: string; grace_field?: string; image_field?: string };
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  // OFF by default. The board's first job is to be readable from across the
  // room; controls on every tile all the time is a worse board. Turning them on
  // is one tap and the state is obvious, which is the trade a wall panel wants.
  const [editing, setEditing] = useState(false);
  // Which tile is mid-flight, so a tap has an immediate answer. Without it
  // people tap twice and the double decrement teaches them the thing lies.
  const [busy, setBusy] = useState<string | null>(null);
  // The last thing done, offered back. Mis-taps on a wall screen are certain;
  // if undo is buried people stop tapping rather than risk being wrong.
  const [lastAction, setLastAction] = useState<{ id: string; title: string; undo: () => Promise<void> } | null>(null);

  // Through the one door (platform-web run-action): the action's completion
  // refreshes every query showing the record's kind, wherever this grid is
  // embedded. This used to invalidate the two keys it knew, and the page it
  // lives on read through a third (#2969).
  // PRESS-ARGS: use-one and restock-one require nothing; the tap adds its timezone.
  const runAction = useRunAction();

  /** One tap. `dir` is -1 for "used one", +1 for "another arrived". */
  const tap = async (row: ViewRow, dir: -1 | 1) => {
    if (!activeSlug || busy) return;
    const key = `${row.kind}:${row.id}`;
    setBusy(key);
    const actionId = dir === -1 ? "inventory:use-one" : "inventory:restock-one";
    const inverse = dir === -1 ? "inventory:restock-one" : "inventory:use-one";
    // The panel knows where it is standing; the server must not guess a
    // calendar day from a UTC clock (a 9pm tap would date tomorrow).
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      await runAction({ actionId, entityKind: row.kind, entityId: row.id, args: { timezone } }, { undo: "shown-here" });
      setLastAction({
        id: key,
        title: row.title ?? "that",
        undo: async () => {
          await runAction({ actionId: inverse, entityKind: row.kind, entityId: row.id, args: { timezone } }, { undo: "is-undo" });
          setLastAction(null);
        },
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const qtyField = c.qty_field ?? "qty";
  const expiryField = c.expiry_field ?? "expires_on";
  const minQtyField = c.min_qty_field ?? "min_qty";
  // Food does not go bad at midnight. The item's own grace_days says how long
  // past the date is still fine; within it the tile asks to be used, it does
  // not scream. Meaning lives in the shared expiryState so this dot and the
  // sweeper's event cannot drift on what "spoiled" is.
  const graceField = c.grace_field ?? "grace_days";
  // The photo, the one thing a person recognises from across the kitchen.
  const imageField = c.image_field ?? "image_path";

  // The one countdown (day.ts), from this browser's day: it rounded a UTC
  // midnight against a local one, so the wall and the dashboard could name
  // different days for one item (#3641).
  const today = dayHere();
  const dayDiff = (iso: unknown): number | null => daysUntilField(iso, today);
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  /** A view config names a field; where the projection stores it is not the
   *  config author's problem. Native columns (qty, min_qty) land flat, while
   *  every field a BUNDLE adds - expiry, storage, category - lands nested under
   *  `metadata`. Reading only the flat level meant native fields worked and
   *  bundle fields silently read undefined, so an item expiring tomorrow showed
   *  no expiry status at all. Caught by looking at the grid, not the logs. */
  const pick = (fields: Record<string, unknown>, name: string): unknown => {
    if (fields[name] !== undefined) return fields[name];
    const meta = fields.metadata;
    return meta && typeof meta === "object" ? (meta as Record<string, unknown>)[name] : undefined;
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        {/* COLOUR-NOT-STATE: the label itself turns to Done while the steppers are out. */}
        <button
          type="button"
          onClick={() => { setEditing((v) => !v); setLastAction(null); }}
          // A phone always shows the steppers, so the toggle is for a wall.
          className={
            "hidden sm:inline-flex rounded-full border px-3 py-1.5 text-xs font-medium transition " +
            (editing
              ? "border-cobble-500 bg-cobble-600 text-white"
              : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-cobble-400")
          }
        >
          {editing ? "Done" : "Use / restock"}
        </button>
        {/* Undo sits beside the toggle rather than on the tile: one place to
            look, and it does not move when the grid re-sorts under it. */}
        {lastAction && (
          <button
            type="button"
            onClick={() => void lastAction.undo()}
            className="rounded-full border border-line dark:border-slate-700 px-3 py-1.5 text-xs text-muted dark:text-slate-400 hover:border-cobble-400"
          >
            Undo {lastAction.title}
          </button>
        )}
      </div>
    <div className={TILE_GRID}>
      {items.map((row) => {
        const f = row.fields ?? {};
        const qty = num(pick(f, qtyField));
        const minQty = num(pick(f, minQtyField));
        const days = dayDiff(pick(f, expiryField));
        const grace = expiryState(
          typeof pick(f, expiryField) === "string" ? (pick(f, expiryField) as string) : null,
          pick(f, graceField),
          today,
        );
        const out = qty !== null && qty <= 0;
        const expired = !out && grace?.state === "spoiled";
        const pastDate = !out && grace?.state === "past_date";
        const expiring = !out && days !== null && days >= 0 && days <= 2;
        const low = !out && qty !== null && minQty !== null && qty <= minQty;

        // One dot carries the whole status, so the grid reads as a wall of
        // lights instead of rows to scan. Past-the-date-inside-grace is orange:
        // more urgent than amber "expiring", not yet the red that means binned.
        const dot = out
          ? "bg-slate-400 dark:bg-slate-600"
          : expired
            ? "bg-red-500"
            : pastDate
              ? "bg-orange-500"
              : expiring
                ? "bg-amber-500"
                : low
                  ? "bg-cobble-500"
                  : "bg-emerald-500";

        // Same order as the dot, so the words never contradict the light. It
        // used to prefer any expiry date over low stock, so a tile with an
        // amber running-low dot read "expires in 60d" and the two disagreed.
        const meta = out
          ? "out of stock"
          : expired || pastDate
            ? expiryPhrase(grace!)
            : expiring
              ? days === 0
                ? "expires today"
                : `expires in ${days}d`
              : low
                ? "running low"
                : days !== null
                  ? `expires in ${days}d`
                  : "in stock";

        const rawImage = pick(f, imageField);
        return (
          <VendingTile
            key={`${row.kind}:${row.id}`}
            row={row}
            image={typeof rawImage === "string" && rawImage.trim() ? rawImage : null}
            dot={dot}
            meta={meta}
            qty={qty}
            out={out}
            editing={editing}
            busy={busy !== null}
            onTap={(dir) => void tap(row, dir)}
          />
        );
      })}
    </div>
    </>
  );
}

/**
 * One slot on the wall: the photo, the name, the count and the two steppers.
 *
 * The stepper row is ALWAYS in the layout, so a tile is the same size with the
 * controls on or off: turning on "Use / restock" used to grow every tile and
 * the whole wall jumped under the thumb. On a phone the steppers are simply
 * there (the phone is in the hand in the kitchen, the one place quick +/- is
 * the point); on a wider screen, read from across the room, they appear with
 * the toggle and the space they sit in is kept empty until then.
 */
function VendingTile({
  row,
  image,
  dot,
  meta,
  qty,
  out,
  editing,
  busy,
  onTap,
}: {
  row: ViewRow;
  image: string | null;
  dot: string;
  meta: string;
  qty: number | null;
  out: boolean;
  editing: boolean;
  busy: boolean;
  onTap: (dir: -1 | 1) => void;
}) {
  const title = row.title ?? "";
  const stepper =
    "flex-1 rounded-md border border-line dark:border-slate-600 bg-panel dark:bg-slate-900 py-2.5 text-lg font-bold text-content dark:text-slate-100 disabled:opacity-40 active:scale-95 transition";
  return (
    <RecordCard
      row={row}
      data-testid="vending-tile"
      className={
        "relative flex flex-col overflow-hidden rounded-lg border transition " +
        (out
          ? "border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-900/50"
          : "border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 hover:border-cobble-400")
      }
    >
      {/* Every slot is the same 4:3 box whatever its photo: the frame sizes it
          before the picture arrives, so a tall bag cannot stretch its row. */}
      <RecordLink row={row} className={"relative block " + (out ? "opacity-60" : "")}>
        <EntityPhoto src={image} alt={title} aspect="4/3" className="bg-panel dark:bg-slate-900">
          <span className={`absolute right-2 top-2 h-3 w-3 rounded-full ring-2 ring-white/80 dark:ring-slate-900/80 ${dot}`} aria-hidden />
          {qty !== null && !out && (
            <span className="absolute bottom-2 right-2 rounded-full border border-line dark:border-slate-600 bg-panel dark:bg-slate-900 px-2 py-0.5 text-sm font-bold shadow-sm text-content dark:text-slate-100">
              ×{qty}
            </span>
          )}
          {out && (
            <span className="absolute bottom-2 left-2 rounded bg-red-500/90 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
              Sold out
            </span>
          )}
        </EntityPhoto>
      </RecordLink>
      <div className="flex flex-1 flex-col p-3">
        {/* Two lines kept for every title, so the meta under it sits at the
            same height in every slot along the row. */}
        <EntityTitleLink row={row} className="min-h-[2.75rem] text-base font-semibold leading-snug line-clamp-2" />
        <div className="mt-0.5 text-xs text-muted dark:text-slate-400">{meta}</div>
        <div
          data-testid="vending-steppers"
          className={"mt-auto flex items-stretch gap-2 pt-3 " + (editing ? "" : "sm:invisible")}
        >
          <button
            type="button"
            aria-label={`Used one ${title}`}
            disabled={busy || out}
            onClick={() => onTap(-1)}
            className={stepper}
          >
            −
          </button>
          <button
            type="button"
            aria-label={`Another ${title} arrived`}
            disabled={busy}
            onClick={() => onTap(1)}
            className={stepper}
          >
            +
          </button>
        </div>
      </div>
    </RecordCard>
  );
}

export function ListRenderer({ items }: { items: ViewRow[] }) {
  const stock = useRowStock();
  return (
    <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded">
      {items.map((row) => (
        <RecordCard as="li" key={`${row.kind}:${row.id}`} row={row} className="px-3 py-2 text-sm">
          <div className="flex items-center gap-3">
            <EntityTitleLink row={row} className="font-medium" />
            {row.subtitle && (
              <span className="text-xs text-muted">{row.subtitle}</span>
            )}
            {stock.on && <span className="ml-auto shrink-0">{stock.stepper(row)}</span>}
          </div>
        </RecordCard>
      ))}
    </ul>
  );
}

export function KanbanRenderer({
  slug,
  kind,
  items,
  groupBy,
}: {
  slug: string;
  kind: string;
  items: ViewRow[];
  groupBy: string;
}) {
  // Group rows by config.group_by through the one rule (groupKeyOf), and lay
  // the columns out in the field's declared order, empty ones kept.
  const areaOf = useAreaResolver(groupBy === LOCATION_GROUP_KEY);
  const declared = useKindFields(slug, kind).find((f) => f.name === groupBy)?.choices;
  const cols = orderedGroups(groupRows(items, groupBy, areaOf), declared);
  const stock = useRowStock();
  // A card crosses columns only when the columns are the field's declared
  // choices (a drop is always a legal value) and the kind has a writer.
  const { edit, writable } = useViewRecordEdit(slug);
  const legal = boardColumnValues(cols.map(([c]) => c), declared);
  const draggable = !!declared?.length && writable(kind);
  const words = (col: string) => (col === NO_GROUP ? NO_GROUP_LABEL : col);
  return (
    <BoardDnd
      enabled={draggable}
      label={words}
      onMove={(row, to) => {
        if (!legal.has(to)) return;
        void edit(row, { [groupBy]: legal.get(to) ?? null }, `${row.title} is ${words(to)} now`);
      }}
    >
    <div className="flex gap-3 overflow-x-auto pb-2" data-board-draggable={draggable ? "true" : undefined}>
      {cols.map(([col, rows]) => (
        <BoardColumn
          key={col}
          col={col}
          droppable={draggable && legal.has(col)}
        >
          <div className="px-2 py-1.5 border-b border-line dark:border-slate-700 flex items-center justify-between">
            <span className="text-xs font-medium text-content dark:text-slate-300 truncate">
              {col === NO_GROUP ? NO_GROUP_LABEL : col}
            </span>
            <span className="text-[10px] text-faint">{rows.length}</span>
          </div>
          <ul className="p-2 space-y-1.5 min-h-[2.5rem]">
            {rows.map((r) => (
              <BoardCard key={`${r.kind}:${r.id}`} row={r} col={col}>
                <div className="font-medium truncate">
                  <EntityTitleLink row={r} />
                </div>
                {r.subtitle && col !== r.subtitle && (
                  <div className="text-[10px] text-muted truncate">
                    {r.subtitle}
                  </div>
                )}
                {stock.on && <div className="mt-1 flex justify-end">{stock.stepper(r)}</div>}
              </BoardCard>
            ))}
          </ul>
        </BoardColumn>
      ))}
    </div>
    </BoardDnd>
  );
}

/** A board column's value to write, by its drawn name: each declared choice
 *  is its own value and "No value" clears the field. A column that exists
 *  only because a row carries an undeclared value is not a drop target. */
export function boardColumnValues(columns: string[], declared: readonly string[] | undefined): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!declared?.length) return out;
  const byLower = new Map(declared.map((d) => [d.toLowerCase(), d] as const));
  for (const c of columns) {
    if (c === NO_GROUP) out.set(c, null);
    else if (byLower.has(c.toLowerCase())) out.set(c, byLower.get(c.toLowerCase())!);
  }
  return out;
}

function BoardColumn({ col, droppable, children }: { col: string; droppable: boolean; children: ReactNode }) {
  const drop = useBoardColumn(col);
  return (
    <div
      ref={droppable ? drop.ref : undefined}
      data-board-column={col}
      className={
        "min-w-[200px] max-w-[260px] shrink-0 border rounded transition-colors " +
        (drop.over && droppable ? "border-accent bg-accent/10" : "border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-900/40")
      }
    >
      {children}
    </div>
  );
}

function BoardCard({ row, col, children }: { row: ViewRow; col: string; children: ReactNode }) {
  const drag = useBoardCard(row, col);
  return (
    <RecordCard
      as="li"
      row={row}
      dragRef={drag.enabled ? drag.ref : undefined}
      dragProps={drag.props}
      style={drag.style}
      className={
        "px-2 py-1.5 text-xs rounded bg-surface dark:bg-slate-800 border border-line dark:border-slate-700" +
        (drag.enabled ? " touch-manipulation" : "") +
        (drag.dragging ? " shadow-lg ring-2 ring-accent" : "")
      }
    >
      {children}
    </RecordCard>
  );
}

export function TableRenderer({
  slug,
  kind,
  items,
  columns,
  groupBy,
  selection,
  layout = "auto",
}: {
  slug: string;
  kind: string;
  items: ViewRow[];
  columns?: string[];
  groupBy?: string;
  /** When present, renders a checkbox column for bulk actions. */
  selection?: { selected: Set<string>; toggle: (id: string) => void };
  /** "auto" stacks the rows on a phone (a wide table shows a row's name or its
   *  state, never both, #6340); "table" always draws the table, for a caller
   *  that has its own phone layout. */
  layout?: "auto" | "table";
}) {
  // Default to title + subtitle when no visible_fields declared.
  // When declared, render each as a column read from row.fields.
  const cols = columns && columns.length > 0 ? columns : ["title", "subtitle"];
  // Each column under the collection's own word for it (useKindFields reads
  // the field defs and the collection's relabels), never the storage key:
  // "drink_by" and "manufacturer" headed Wine's Ready to drink.
  const fields = useKindFields(slug, kind);
  const headerOf = (c: string) => (c === "title" ? "Name" : c === "subtitle" ? "" : fields.find((f) => f.name === c)?.label ?? humanize(c));
  // The cell that opens the record: its title, or the first column when a
  // view shows no title.
  const linkCol = cols.includes("title") ? "title" : cols[0];
  // A counted collection steps its count in the view's own qty column, or in
  // one of its own when the view does not show qty.
  const stock = useRowStock();
  const stockCol = stock.on && !cols.includes("qty");
  const selectCols = (selection ? cols.length + 1 : cols.length) + (stockCol ? 1 : 0);

  // When group_by is set, split rows into ordered sections with a header
  // row each, through the one rule (groupKeyOf).
  const areaOf = useAreaResolver(groupBy === LOCATION_GROUP_KEY);
  const groups: Array<{ key: string; rows: ViewRow[] }> = [];
  if (groupBy) {
    // Sections in the field's declared order too; a table leaves out the empty
    // ones a board keeps, since an empty section header is a row of nothing.
    const declared = fields.find((f) => f.name === groupBy)?.choices;
    for (const [key, rows] of orderedGroups(groupRows(items, groupBy, areaOf), declared)) if (rows.length) groups.push({ key, rows });
  } else {
    groups.push({ key: "", rows: items });
  }

  const phone = usePhoneLayout();
  const routeFor = useDetailRoute(slug);
  const navigate = useNavigate();
  if (phone && layout === "auto" && !groupBy) {
    const stateCol = cols.find((c) => c === "state" || c === "status");
    const shown = cols.filter((c) => c !== "title" && c !== "subtitle" && c !== stateCol && !(c === "qty" && stock.on));
    const byId = new Map(items.map((r) => [r.id, r]));
    return (
      <PhoneRecordList
        rows={items.map((r) => ({
          id: r.id,
          name: cols.includes("title") ? r.title : formatCell(cols[0]!, r, fields.find((f) => f.name === cols[0])?.money) || r.title,
          state: stateCol ? formatCell(stateCol, r) : null,
          identity: [cols.includes("subtitle") ? r.subtitle : null],
          fields: shown.map((c) => ({ label: headerOf(c) || humanize(c), value: formatCell(c, r, fields.find((f) => f.name === c)?.money) })),
          trailing: stock.on ? stock.stepper(r) : undefined,
        }))}
        onOpen={(id) => {
          const r = byId.get(id);
          const href = r && routeFor(r.kind, r.id, (r as { detailUrl?: string | null }).detailUrl);
          if (href) navigate(href);
        }}
        selection={selection ? { selected: selection.selected, onToggle: (id) => selection.toggle(id) } : undefined}
      />
    );
  }

  const Row = (r: ViewRow) => (
    <RecordCard as="tr" key={`${r.kind}:${r.id}`} row={r} className="border-b border-line dark:border-slate-800 last:border-b-0 hover:bg-subtle/40 dark:hover:bg-slate-800/40">
      {selection && (
        <td className="px-2 py-1.5 align-top w-8">
          <input
            type="checkbox"
            checked={selection.selected.has(r.id)}
            onChange={() => selection.toggle(r.id)}
            aria-label={`Select ${r.title}`}
          />
        </td>
      )}
      {cols.map((c) => (
        <td key={c} className="px-3 py-1.5 align-top truncate max-w-[260px]">
          {c === linkCol ? (
            <RecordLink row={r} className="hover:text-accent hover:underline">{formatCell(c, r, fields.find((f) => f.name === c)?.money)}</RecordLink>
          ) : c === "qty" && stock.on ? (
            stock.stepper(r) ?? formatCell(c, r, fields.find((f) => f.name === c)?.money)
          ) : (
            formatCell(c, r, fields.find((f) => f.name === c)?.money)
          )}
        </td>
      ))}
      {stockCol && <td className="px-3 py-1 align-top text-right">{stock.stepper(r)}</td>}
    </RecordCard>
  );

  return (
    <div className="overflow-x-auto border border-line dark:border-slate-700 rounded">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-800/40">
            {selection && <th className="px-2 py-1.5 w-8" />}
            {cols.map((c) => (
              <th
                key={c}
                className="px-3 py-1.5 text-left text-[10px] uppercase text-muted tracking-wider"
              >
                {headerOf(c)}
              </th>
            ))}
            {stockCol && <th className="px-3 py-1.5 text-right text-[10px] uppercase text-muted tracking-wider">{headerOf("qty")}</th>}
          </tr>
        </thead>
        {groupBy ? (
          groups.map((g) => (
            <tbody key={g.key}>
              <tr className="bg-cobble-50/70 dark:bg-cobble-900/20">
                <td colSpan={selectCols} className="px-3 py-1 text-[10px] uppercase tracking-widest text-accent">
                  {g.key === NO_GROUP ? NO_GROUP_LABEL : g.key} · {g.rows.length}
                </td>
              </tr>
              {g.rows.map(Row)}
            </tbody>
          ))
        ) : (
          <tbody>{items.map(Row)}</tbody>
        )}
      </table>
    </div>
  );
}

/** Read a field off a resolved row. Custom (bundle / user-authored) field
 *  values live nested under `fields.metadata` — most module resolvers return
 *  `fields: row`, so a custom column like `mileage` is at
 *  `fields.metadata.mileage`, not `fields.mileage`. Try the top level first
 *  (native columns + computed fields), then fall back to metadata, so a
 *  saved view's `visible_fields`/`group_by` reaches custom fields too. */
function formatCell(col: string, row: ViewRow, money?: MoneyStorage): string {
  if (col === "title") return row.title;
  if (col === "subtitle") return row.subtitle ?? "";
  const v = fieldVal(row.fields, col);
  if (v === null || v === undefined) return "";
  if (money) return formatStoredMoney(v, money, { currency: fieldCurrency(row.fields?.metadata, col) }) ?? "";
  const linked = fieldVal(row.fields, `${col}_label`);
  if (linked) return String(linked);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v && typeof v === "object" && "amount" in v && "currency" in v) return formatMoney(centsFromAmount(Number(v.amount)), { currency: String(v.currency) });
  const label = fieldVal(row.fields, `${col}_label`);
  if (label) return String(label);
  return JSON.stringify(v);
}

// Gallery renderer — a card grid with a prominent image per row (the poster
// wall). Reads cfg.image_field (default "image_path"; e.g. a "poster" url/path)
// for the image and cfg.caption_field for an optional caption under the title.
// Rows without an image show a title-initial tile. This is the signature view
// for a catalog (films, books, recipes). See one-record-substrate.md.
// One gallery tile.
//
// image_path is free-form: an external catalog URL, or a relative core-files
// path that needs the Bearer JWT, which <img src> cannot carry. Every cover in
// a bookshelf gallery once came back 401 while the LIST view beside it was
// fine, because the list resolved its photo and this tile did not. EntityPhoto
// is the one door for both: it resolves the path and gives the cover its 2:3
// box before the picture arrives.
function GalleryTile({ row, src, title, caption }: { row: ViewRow; src: string | null; title: string; caption: string }) {
  // The stepper sits under the tile, outside its link: a button inside the
  // link that opens the record would open it on every tap.
  const stock = useRowStock().stepper(row);
  const tile = (
    <RecordLink
      row={row}
      card
      data-testid="gallery-tile"
      className="block rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden hover:border-accent transition"
    >
      <EntityPhoto src={src} alt={title} aspect="2/3" />
      <div className="p-2">
        <div data-tile-title title={title} className={`${TILE_TITLE} text-sm`}>{title}</div>
        {distinctSubtitle(title, caption) && <div className="truncate text-xs text-muted dark:text-slate-400">{caption}</div>}
      </div>
    </RecordLink>
  );
  if (!stock) return tile;
  return (
    <div className="flex flex-col gap-1">
      {tile}
      <div className="flex justify-end">{stock}</div>
    </div>
  );
}

export function GalleryRenderer({ items, cfg }: { items: ViewRow[]; cfg: ViewConfig }) {
  const imageField = (cfg.image_field as string) || "image_path";
  const captionField = cfg.caption_field as string | undefined;
  return (
    <div className={TILE_GRID}>
      {items.map((row) => {
        const raw = fieldVal(row.fields, imageField);
        const src = typeof raw === "string" && raw.trim() ? raw : null;
        const caption = captionField ? formatCell(captionField, row) : row.subtitle ?? "";
        return <GalleryTile key={`${row.kind}:${row.id}`} row={row} src={src} title={row.title} caption={caption} />;
      })}
    </div>
  );
}

// Heatmap renderer — a GitHub-style contribution grid: one square per day for
// the last 26 weeks, shaded by how many rows fall on that day (cfg.date_field,
// default "date"). The signature view for a habit tracker. Dependency-free —
// plain divs. See one-record-substrate.md.
export function HeatmapRenderer({ items, cfg }: { items: ViewRow[]; cfg: Record<string, unknown> }) {
  const dateField = (cfg.date_field as string) || "date";
  const WEEKS = 26;
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) {
      const dv = fieldVal(it.fields, dateField);
      if (dv == null || dv === "") continue;
      const key = String(dv).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      m[key] = (m[key] ?? 0) + 1;
    }
    return m;
  }, [items, dateField]);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const { columns, monthLabels, max } = useMemo(() => {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - (WEEKS - 1) * 7 - today.getDay());
    const cols: { key: string; count: number }[][] = [];
    const labels: string[] = [];
    let mx = 0;
    let prevMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const col: { key: string; count: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const cur = new Date(start);
        cur.setDate(start.getDate() + w * 7 + d);
        const key = isoLocal(cur);
        const c = counts[key] ?? 0;
        if (c > mx) mx = c;
        col.push({ key, count: c });
      }
      const first = new Date(start);
      first.setDate(start.getDate() + w * 7);
      const mo = first.getMonth();
      labels.push(mo !== prevMonth ? MON[mo]! : "");
      prevMonth = mo;
      cols.push(col);
    }
    return { columns: cols, monthLabels: labels, max: mx };
  }, [counts]);
  const shades = [
    "bg-subtle dark:bg-slate-800",
    "bg-cobble-200 dark:bg-cobble-900/50",
    "bg-cobble-300 dark:bg-cobble-800/70",
    "bg-cobble-400 dark:bg-cobble-700",
    "bg-cobble-500 dark:bg-cobble-500",
  ];
  const shade = (c: number): string => {
    if (c <= 0) return shades[0]!;
    const lvl = max <= 1 ? 4 : Math.min(4, Math.ceil((c / max) * 4));
    return shades[lvl]!;
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // The expected-cadence overlay. Without it every gap looks the same — a rest
  // day and a skipped day are both an empty square. With it, the days the
  // cadence expects are OUTLINED, so a gap inside an outline is a real miss and
  // a gap outside one is simply not a day you were meant to go. Absence reads as
  // absence: a missed day is an un-filled outline, never a red mark.
  // rrule is ~30KB gz and ViewsPage is eagerly imported by App, so the expander
  // is fetched ON DEMAND — only once a view actually declares a cadence. A view
  // without one costs nothing and never touches the network for it.
  const rule = (cfg.expect_rrule as string | undefined) ?? "";
  const first = columns[0]?.[0]?.key;
  const last = columns[columns.length - 1]?.[6]?.key;
  const [expected, setExpected] = useState<Set<string>>(new Set());
  const [invalidRule, setInvalidRule] = useState(false);
  useEffect(() => {
    if (!rule.trim() || !first || !last) {
      setExpected(new Set());
      setInvalidRule(false);
      return;
    }
    let cancelled = false;
    void import("../lib/cadence-expand")
      .then(({ expandExpectedDays }) => {
        if (cancelled) return;
        const r = expandExpectedDays(rule, new Date(`${first}T00:00:00`), new Date(`${last}T00:00:00`));
        setExpected(r.days);
        setInvalidRule(r.invalid);
      })
      .catch(() => {
        // The overlay is an aid, not the view. If its chunk fails to load the
        // grid still renders — it just isn't outlined.
        if (!cancelled) setInvalidRule(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rule, first, last]);
  const tally = useMemo(() => tallyCadence(expected, counts, new Date()), [expected, counts]);

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-mono text-faint dark:text-slate-500">
        {total} logged over {WEEKS} weeks · each square is a day
        {tally.expected > 0 && (
          <>
            {" · "}
            <span className="text-content dark:text-mortar-200">
              {tally.kept}/{tally.expected} expected days kept
            </span>
            {tally.streak > 0 && ` · ${tally.streak}-day streak`}
          </>
        )}
      </div>
      {invalidRule && (
        <div className="text-[10px] font-mono text-faint dark:text-slate-500">
          The expected cadence could not be read, so no days are outlined. Edit the view to fix it.
        </div>
      )}
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-1 mb-1">
          {monthLabels.map((m, i) => (
            <div key={i} className="w-3 text-[8px] uppercase tracking-wide text-faint dark:text-slate-500 whitespace-nowrap leading-none">
              {m}
            </div>
          ))}
        </div>
        <div className="flex gap-1">
          {columns.map((col, i) => (
            <div key={i} className="flex flex-col gap-1">
              {col.map((cell) => {
                const due = expected.has(cell.key);
                return (
                  <div
                    key={cell.key}
                    title={
                      due
                        ? `${cell.key}: ${cell.count}${cell.count > 0 ? "" : " (expected)"}`
                        : `${cell.key}: ${cell.count}`
                    }
                    className={
                      "w-3 h-3 rounded-sm " +
                      shade(cell.count) +
                      (due ? " ring-1 ring-inset ring-cobble-500/70 dark:ring-cobble-400/70" : "")
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1 justify-end text-[9px] font-mono text-faint dark:text-slate-500">
        <span>less</span>
        {shades.map((s, i) => (
          <div key={i} className={"w-3 h-3 rounded-sm " + s} />
        ))}
        <span>more</span>
      </div>
    </div>
  );
}

const VIEW_LAYOUTS = ["list", "table", "kanban", "trend", "calendar", "gantt", "gallery", "heatmap", "vending"] as const;
type ViewLayout = (typeof VIEW_LAYOUTS)[number];

/** A view's layout: one of nine, a radio group whose pick is marked with a
 *  check as well as its fill, never told by colour alone (#6086). */
function LayoutPicker({ value, onChange }: { value: ViewLayout; onChange: (t: ViewLayout) => void }) {
  return (
    <div role="radiogroup" aria-label="Layout" className="flex flex-wrap gap-1">
      {VIEW_LAYOUTS.map((t, i) => (
        <button
          key={t}
          type="button"
          {...rovingRadio(i, VIEW_LAYOUTS.indexOf(value))}
          role="radio"
          aria-checked={value === t}
          onClick={() => onChange(t)}
          className={`min-h-11 flex-1 inline-flex items-center justify-center gap-1 px-3 text-xs rounded transition ${
            value === t
              ? "bg-cobble-600 text-white"
              : "bg-subtle dark:bg-slate-800 text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-700"
          }`}
        >
          {value === t && <Check size={12} strokeWidth={2.5} aria-hidden data-picked-mark />}
          {t}
        </button>
      ))}
    </div>
  );
}

function CreateViewModal({
  slug,
  onClose,
  onCreated,
  initialKind = "inventory:part",
  initialTable = false,
}: {
  slug: string;
  onClose: () => void;
  onCreated: (id: string) => void;
  initialKind?: string;
  initialTable?: boolean;
}) {
  const [entityKind, setEntityKind] = useState(initialKind);
  const [name, setName] = useState("");
  const [viewType, setViewType] = useState<"list" | "table" | "kanban" | "trend" | "calendar" | "gantt" | "gallery" | "heatmap" | "vending">(initialTable ? "table" : "list");
  const [groupBy, setGroupBy] = useState("");
  const [tableGroups, setTableGroups] = useState<GroupBy[]>([]);
  const [columns, setColumns] = useState<string[]>(["title", "subtitle"]);
  const [dateField, setDateField] = useState("due_date");
  const [startField, setStartField] = useState("start_date");
  const [endField, setEndField] = useState("target_date");
  const [imageField, setImageField] = useState("image_path");
  const [captionField, setCaptionField] = useState("");
  const [xField, setXField] = useState("measured_at");
  const [yField, setYField] = useState("value");
  const [goal, setGoal] = useState("");
  const [titleField, setTitleField] = useState("");
  const [expectRrule, setExpectRrule] = useState("");
  const [filterRows, setFilterRows] = useState<FilterRow[]>([]);
  const [sortRows, setSortRows] = useState<SortRow[]>([]);
  const [shared, setShared] = useState(true);
  const toast = useToast();
  const create = useMutation({
    mutationFn: (input: Parameters<typeof api.createSavedView>[1]) => api.createSavedView(slug, input),
    onSuccess: (saved) => { toast.success("View saved"); onCreated(saved.id); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  });

  // The kind's fields (native + custom) drive every picker below.
  const fields = useKindFields(slug, entityKind);

  // If the workspace has ALREADY told the platform this kind's rhythm — a
  // schedule wire carrying an RRULE ("every weekday, remind me") — a heatmap of
  // that kind should not make you say it a second time. Default the expected
  // cadence from it. Only when there is EXACTLY ONE schedule wire on the kind:
  // with two, "the" cadence is a guess, and a wrong outline is worse than none.
  // It is a DEFAULT, not a lock — it lands in the picker where you can see it
  // and change it (same discipline as the derived item-noun).
  const bindings = useQuery({
    queryKey: ["bindings", slug],
    queryFn: () => api.listBindings(slug),
    enabled: !!slug,
  });
  const suggestedCadence = useMemo(() => {
    const scheduled = (bindings.data?.items ?? []).filter(
      (b) => b.source_kind === entityKind && b.trigger_type === "schedule" && b.trigger_schedule,
    );
    return scheduled.length === 1 ? (scheduled[0]!.trigger_schedule as string) : "";
  }, [bindings.data, entityKind]);
  // Apply it when the user turns to a heatmap and hasn't chosen a cadence
  // themselves. Keyed on the suggestion + kind so switching kinds re-suggests,
  // and never overwrites a value the user typed.
  const [cadenceTouched, setCadenceTouched] = useState(false);
  useEffect(() => {
    if (!cadenceTouched && suggestedCadence) setExpectRrule(suggestedCadence);
  }, [suggestedCadence, cadenceTouched]);

  // Discover entity kinds from the registry so the user picks a real one.
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });

  return (
    <Modal open onClose={onClose} title="New saved view">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const config = layoutConfig(viewType, {}, {
            group_by: viewType === "table" ? tableGroupingValue(tableGroups) : groupBy,
            visible_fields: columns,
            date_field: dateField,
            expect_rrule: expectRrule,
            image_field: imageField,
            caption_field: captionField,
            x: xField,
            y: yField,
            goal: goal.trim() && Number.isFinite(Number(goal)) ? Number(goal) : "",
            title_field: titleField,
            start_field: startField,
            end_field: endField,
          });
          // filter/sort apply to every layout.
          Object.assign(config, filterRowsToConfig(filterRows));
          const sort = rowsToSort(sortRows);
          if (sort.length) config.sort = sort;
          create.mutate({
              entity_kind: entityKind,
              name: name.trim(),
              view_type: viewType,
              config,
              shared,
          });
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Entity kind</div>
          <select
            value={entityKind}
            onChange={(e) => setEntityKind(e.target.value)}
            data-testid="view-entity-kind"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            {(kinds.data?.items ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.display_name} ({k.id})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Low stock"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <div>
          <div className="text-xs text-muted mb-1">Layout</div>
          <LayoutPicker value={viewType} onChange={setViewType} />
        </div>
        {(viewType === "calendar" || viewType === "heatmap") && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Date field</div>
            <FieldSelect fields={fields} value={dateField} onChange={setDateField} allowBlank blankLabel="Pick a date field…" />
            <div className="text-[11px] text-faint mt-1">Which field each row lands on.</div>
          </label>
        )}
        {viewType === "heatmap" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Expected cadence (optional)</div>
            <select
              value={CADENCE_PRESETS.some((c) => c.rrule === expectRrule) || expectRrule === "" ? expectRrule : "__custom"}
              onChange={(e) => {
                setCadenceTouched(true);
                setExpectRrule(e.target.value === "__custom" ? "FREQ=DAILY;INTERVAL=1" : e.target.value);
              }}
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            >
              <option value="">No expectation (just count what happened)</option>
              {CADENCE_PRESETS.map((c) => (
                <option key={c.rrule} value={c.rrule}>{c.label}</option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
            {expectRrule !== "" && !CADENCE_PRESETS.some((c) => c.rrule === expectRrule) && (
              <input
                type="text"
                value={expectRrule}
                onChange={(e) => {
                  setCadenceTouched(true);
                  setExpectRrule(e.target.value);
                }}
                placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                className="mt-2 w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            )}
            <div className="text-[11px] text-faint mt-1">
              Outlines the days you meant to do this, so a gap reads as a miss and a rest day doesn't.
              {!cadenceTouched && suggestedCadence && expectRrule === suggestedCadence && " Taken from this list's schedule. Change it if that's not the rhythm you want to see."}
            </div>
          </label>
        )}
        {viewType === "gallery" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Image field</div>
            <FieldSelect fields={fields} value={imageField} onChange={setImageField} allowBlank blankLabel="Pick an image field…" />
            <div className="text-xs text-muted mb-1 mt-2">Caption field (optional)</div>
            <FieldSelect fields={fields} value={captionField} onChange={setCaptionField} allowBlank blankLabel="No caption" />
          </label>
        )}
        {viewType === "trend" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <div className="text-xs text-muted mb-1">Date field (x)</div>
                <FieldSelect fields={fields} value={xField} onChange={setXField} allowBlank blankLabel="Pick a date field…" />
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Value field (y)</div>
                <FieldSelect fields={fields} value={yField} onChange={setYField} allowBlank blankLabel="Pick a number field…" />
              </label>
            </div>
            <label className="block">
              <div className="text-xs text-muted mb-1">Goal line (optional)</div>
              <input
                type="number"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. 80"
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
              <div className="text-[11px] text-faint mt-1">Draws a target line across the chart.</div>
            </label>
          </div>
        )}
        {(viewType === "calendar" || viewType === "gantt") && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Label field (optional)</div>
            <FieldSelect fields={fields} value={titleField} onChange={setTitleField} allowBlank blankLabel="Title (default)" />
            <div className="text-[11px] text-faint mt-1">What each entry reads as.</div>
          </label>
        )}
        {viewType === "gantt" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="text-xs text-muted mb-1">Start field</div>
              <FieldSelect fields={fields} value={startField} onChange={setStartField} allowBlank blankLabel="—" />
            </label>
            <label className="block">
              <div className="text-xs text-muted mb-1">End field</div>
              <FieldSelect fields={fields} value={endField} onChange={setEndField} allowBlank blankLabel="—" />
            </label>
          </div>
        )}
        {viewType === "kanban" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Group by</div>
            <FieldSelect fields={fields} value={groupBy} onChange={setGroupBy} allowBlank blankLabel="Subtitle (default)" />
          </label>
        )}
        {viewType === "table" && (
          <>
            <div>
              <div className="text-xs text-muted mb-1">Columns</div>
              <ColumnPicker fields={fields} value={columns} onChange={setColumns} />
            </div>
            <TableGrouping fields={fields} value={tableGroups} onChange={setTableGroups} />
          </>
        )}
        <div>
          <div className="text-xs text-muted mb-1">Filter</div>
          <FilterBuilder fields={fields} rows={filterRows} onChange={setFilterRows} />
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Sort</div>
          <SortBuilder fields={fields} rows={sortRows} onChange={setSortRows} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          Share with workspace (uncheck to keep private)
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {create.isPending ? "Saving…" : "Save view"}
          </button>
        </div>
      </form>
    </Modal>
  );
}


export function EditViewModal({
  slug,
  view,
  onClose,
  onSaved,
}: {
  slug: string;
  view: SavedView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editLabels = useKindLabels(slug);
  // Edit form is simpler than create: name + view_type + view-type-
  // specific config + shared toggle. Entity kind is locked because
  // changing it would invalidate the config's filter / where /
  // sort which are kind-specific.
  const [name, setName] = useState(view.name);
  const [viewType, setViewType] = useState<"list" | "table" | "kanban" | "trend" | "calendar" | "gantt" | "gallery" | "heatmap" | "vending">(
    (view.view_type as "list" | "table" | "kanban" | "trend" | "calendar" | "gantt" | "gallery" | "heatmap" | "vending") ?? "list",
  );
  const cfg = (view.config ?? {}) as ViewConfig;
  const fields = useKindFields(slug, view.entity_kind);
  const [groupBy, setGroupBy] = useState(typeof cfg.group_by === "string" ? cfg.group_by : "");
  const [tableGroups, setTableGroups] = useState<GroupBy[]>(() => normalizeGrouping(cfg.group_by));
  const [columns, setColumns] = useState<string[]>((cfg.visible_fields as string[]) ?? ["title", "subtitle"]);
  const [dateField, setDateField] = useState((cfg.date_field as string) ?? "due_date");
  const [startField, setStartField] = useState((cfg.start_field as string) ?? "start_date");
  const [endField, setEndField] = useState((cfg.end_field as string) ?? "target_date");
  const [imageField, setImageField] = useState((cfg.image_field as string) ?? "image_path");
  const [captionField, setCaptionField] = useState((cfg.caption_field as string) ?? "");
  const [xField, setXField] = useState((cfg.x as string) ?? "measured_at");
  const [yField, setYField] = useState((cfg.y as string) ?? "value");
  const [goal, setGoal] = useState(cfg.goal == null ? "" : String(cfg.goal));
  const [titleField, setTitleField] = useState((cfg.title_field as string) ?? "");
  const [expectRrule, setExpectRrule] = useState((cfg.expect_rrule as string) ?? "");
  const [filterRows, setFilterRows] = useState<FilterRow[]>(() => configToFilterRows(cfg));
  const [sortRows, setSortRows] = useState<SortRow[]>(() => sortToRows(cfg.sort));
  const [shared, setShared] = useState(view.owner_user_id === null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  return (
    <Modal open onClose={onClose} title={`Edit view: ${view.name}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          const config = layoutConfig(viewType, cfg, {
            group_by: viewType === "table" ? tableGroupingValue(tableGroups) : groupBy,
            visible_fields: columns,
            date_field: dateField,
            expect_rrule: expectRrule,
            image_field: imageField,
            caption_field: captionField,
            x: xField,
            y: yField,
            goal: goal.trim() && Number.isFinite(Number(goal)) ? Number(goal) : "",
            title_field: titleField,
            start_field: startField,
            end_field: endField,
          });
          // Rebuild filter/where from the structured builder. Column-to-column
          // (`ref_col`) predicates — e.g. low-stock `qty < min_qty` — can't be
          // expressed in the simple builder, so carry any existing ones through
          // untouched rather than dropping them on save.
          const rebuilt = filterRowsToConfig(filterRows);
          const preservedWhere = (
            (cfg.where as Array<{ col: string; op: string; value?: unknown; ref_col?: unknown }> | undefined) ?? []
          ).filter((w) => w && w.ref_col);
          if (rebuilt.filter) config.filter = rebuilt.filter;
          else delete config.filter;
          const where = [...preservedWhere, ...(rebuilt.where ?? [])];
          if (where.length) config.where = where;
          else delete config.where;
          // Sort applies to every layout.
          const sort = rowsToSort(sortRows);
          if (sort.length) config.sort = sort;
          else delete config.sort;

          try {
            await api.updateSavedView(slug, view.id, {
              name: name.trim(),
              view_type: viewType,
              config,
              shared,
            });
            toast.success("Saved");
            onSaved();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <div className="text-xs text-faint">
          Collection: <span>{editLabels.collection(view.entity_kind)}</span>{" "}
          (locked)
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Layout</div>
          <LayoutPicker value={viewType} onChange={setViewType} />
        </div>
        {(viewType === "calendar" || viewType === "heatmap") && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Date field</div>
            <FieldSelect fields={fields} value={dateField} onChange={setDateField} allowBlank blankLabel="Pick a date field…" />
            <div className="text-[11px] text-faint mt-1">Which field each row lands on.</div>
          </label>
        )}
        {viewType === "heatmap" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Expected cadence (optional)</div>
            <select
              value={CADENCE_PRESETS.some((c) => c.rrule === expectRrule) || expectRrule === "" ? expectRrule : "__custom"}
              onChange={(e) => setExpectRrule(e.target.value === "__custom" ? "FREQ=DAILY;INTERVAL=1" : e.target.value)}
              className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            >
              <option value="">No expectation (just count what happened)</option>
              {CADENCE_PRESETS.map((c) => (
                <option key={c.rrule} value={c.rrule}>{c.label}</option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
            {expectRrule !== "" && !CADENCE_PRESETS.some((c) => c.rrule === expectRrule) && (
              <input
                type="text"
                value={expectRrule}
                onChange={(e) => setExpectRrule(e.target.value)}
                placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                className="mt-2 w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            )}
            <div className="text-[11px] text-faint mt-1">
              Outlines the days you meant to do this, so a gap reads as a miss and a rest day doesn't.
            </div>
          </label>
        )}
        {viewType === "gallery" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Image field</div>
            <FieldSelect fields={fields} value={imageField} onChange={setImageField} allowBlank blankLabel="Pick an image field…" />
            <div className="text-xs text-muted mb-1 mt-2">Caption field (optional)</div>
            <FieldSelect fields={fields} value={captionField} onChange={setCaptionField} allowBlank blankLabel="No caption" />
          </label>
        )}
        {viewType === "trend" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <div className="text-xs text-muted mb-1">Date field (x)</div>
                <FieldSelect fields={fields} value={xField} onChange={setXField} allowBlank blankLabel="Pick a date field…" />
              </label>
              <label className="block">
                <div className="text-xs text-muted mb-1">Value field (y)</div>
                <FieldSelect fields={fields} value={yField} onChange={setYField} allowBlank blankLabel="Pick a number field…" />
              </label>
            </div>
            <label className="block">
              <div className="text-xs text-muted mb-1">Goal line (optional)</div>
              <input
                type="number"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. 80"
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </label>
          </div>
        )}
        {(viewType === "calendar" || viewType === "gantt") && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Label field (optional)</div>
            <FieldSelect fields={fields} value={titleField} onChange={setTitleField} allowBlank blankLabel="Title (default)" />
          </label>
        )}
        {viewType === "gantt" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <div className="text-xs text-muted mb-1">Start field</div>
              <FieldSelect fields={fields} value={startField} onChange={setStartField} allowBlank blankLabel="—" />
            </label>
            <label className="block">
              <div className="text-xs text-muted mb-1">End field</div>
              <FieldSelect fields={fields} value={endField} onChange={setEndField} allowBlank blankLabel="—" />
            </label>
          </div>
        )}
        {viewType === "kanban" && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Group by</div>
            <FieldSelect fields={fields} value={groupBy} onChange={setGroupBy} allowBlank blankLabel="Subtitle (default)" />
          </label>
        )}
        {viewType === "table" && (
          <>
            <div>
              <div className="text-xs text-muted mb-1">Columns</div>
              <ColumnPicker fields={fields} value={columns} onChange={setColumns} />
            </div>
            <TableGrouping fields={fields} value={tableGroups} onChange={setTableGroups} />
          </>
        )}
        <div>
          <div className="text-xs text-muted mb-1">Filter</div>
          <FilterBuilder fields={fields} rows={filterRows} onChange={setFilterRows} />
        </div>
        <div>
          <div className="text-xs text-muted mb-1">Sort</div>
          <SortBuilder fields={fields} rows={sortRows} onChange={setSortRows} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          Shared with workspace
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {busy ? "saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

