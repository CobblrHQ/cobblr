// /machines — list view for the machines module, with a detail
// modal launched per row. URL pattern:
//
//   /machines             — list, no selection
//   /machines/<id>        — list + detail modal open for that row
//   /machines?lens=X      — list with the lens "X" applied (Stage 8)
//
// Lens support is built into the column list here so Stage 8 can
// flip it on with just a URL param read — the wiring is already
// in place for `columns = base + lens.contributedFieldDefs`.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Printer, Search, Tag as TagIcon, Trash2, Wrench } from "lucide-react";
import { ModuleInstanceChooser } from "../components/ModuleInstanceChooser";
import { queueLabelsBulk } from "../lib/queue-label";
import { usePersistedState } from "../lib/use-persisted-state";
import { usePublishChatContext } from "../lib/chat-context";
import { ApiError, api, type Machine, type OrgModuleListItem, type PlatformFieldDef, type SavedView, type BambuDiscoveredDevice, type DigifabConnection, type DigifabDevice, type DigifabFleetDevice } from "../lib/api";
import { fleetStatusChip, indexFleetByMachine } from "../lib/fleet-status";
import { ContributedPageTab, ContributedDetailPanels, hasPageTab } from "../panels/registry";
import { DirectManagerConnect } from "../components/DirectManagerConnect";
import { EntityImageEdit } from "../components/EntityImageEdit";
import { ImageSearchPicker } from "../components/ImageSearchPicker";
// NewMachineModal's inline "connect its manager" flow still reaches the
// digifab feature directly — candidate for its own seam (an intent/action),
// noted in machines-digifab-unification.md §9. The Fleet tab and the Print
// manager panel arrive via the panel registry, NOT this import.
import { EdgeBridgeSetup } from "../features/digifab/fleet";
import { BambuConnectWizard } from "../components/BambuConnectWizard";
import { BambuPrinterPicker } from "../components/BambuPrinterPicker";
import { resolvePrinterKind, hiddenPrinterFields } from "../lib/printerKind";

// Printer "kind" options for the detail-modal selector (same ids as the
// New-3D-printer picker). The kind drives which spec fields are relevant.
const PRINTER_KIND_OPTIONS = [
  { id: "bambu", label: "Bambu Lab" },
  { id: "klipper", label: "Klipper" },
  { id: "prusa", label: "Prusa" },
  { id: "reprap", label: "RepRapFirmware (Duet)" },
  { id: "marlin", label: "Marlin / other" },
  { id: "other", label: "Other / not sure" },
];

// Machine state vocabulary — the lifecycle (kit → building → built → functional →
// rebuilding → loaned → sold) plus the maintenance states. A dropdown, not free
// text. An existing value outside this set is preserved (shown as the first option).
const MACHINE_STATES = [
  "functional", "needs maintenance", "broken", "building", "built", "kit", "rebuilding", "loaned", "sold", "decommissioned",
];
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { ContentsPanel } from "../components/ContentsPanel";
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

const ENTITY_KIND = "machines:machine";

export function MachinesPage({
  instance,
  displayName,
  itemNoun,
}: { instance?: string; displayName?: string; itemNoun?: string } = {}) {
  // When `instance` is set we're rendering ONE named collection of machines
  // (e.g. "3D Printers"), reached at the clean /<instance> URL. Same rich page
  // as /machines — fields, detail/edit, digifab — just scoped to the instance's
  // items. No lens/specialisation grouping (the instance IS the focus), and the
  // detail modal opens via local state instead of a /machines/:id route.
  usePageTitle(displayName ?? "Machines");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const lensName = instance ? null : searchParams.get("lens");
  const noun = itemNoun?.trim() || "machine";

  const [localSel, setLocalSel] = useState<string | null>(null);
  const selectedId = instance ? localSel : id ?? null;
  // Instance detail is local state (no /<instance>/:id route), but it's ALSO
  // deep-linkable via ?machine=<id> — so a fleet tile's "Open machine" can jump
  // straight to a printer's record on its own collection page. The param and
  // localSel stay in sync: arriving with the param opens the modal; opening a
  // card stamps the param; closing clears it.
  useEffect(() => {
    if (!instance) return;
    const m = searchParams.get("machine");
    if (m && m !== localSel) setLocalSel(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, searchParams]);
  const openDetail = (mid: string) => {
    if (instance) {
      setLocalSel(mid);
      setSearchParams((prev) => { prev.set("machine", mid); return prev; }, { replace: true });
    } else navigate(`/machines/${mid}${searchParams.toString() ? `?${searchParams}` : ""}`);
  };
  const closeDetail = () => {
    if (instance) {
      setLocalSel(null);
      setSearchParams((prev) => { prev.delete("machine"); return prev; }, { replace: true });
    } else navigate(`/machines${searchParams.toString() ? `?${searchParams}` : ""}`);
  };

  const machines = useQuery({
    queryKey: ["machines", activeSlug, instance ?? null],
    queryFn: () => api.listMachines(activeSlug, instance),
    enabled: !!activeSlug,
  });
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", activeSlug, ENTITY_KIND, "effective"],
    queryFn: () => api.listFieldDefs(activeSlug, ENTITY_KIND, true),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const orgModules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  // Machines instances (3D Printers / Laser Cutters / CNC…). On the base list
  // (not an instance) with no base-table machines, we show these as a chooser
  // instead of a bare "nothing here" — the aggregate tile lands here.
  const machineInstances = useQuery({
    queryKey: ["instances", activeSlug, "machines"],
    queryFn: () => api.listInstances(activeSlug, "machines"),
    enabled: !!activeSlug && !instance,
    staleTime: 30_000,
  });

  // Which extra columns (beyond the base) to show. A lens scopes the
  // table to one specialisation's contributed field-defs. With NO
  // lens we deliberately show zero extra columns — every enabled
  // specialisation contributes ~5 fields, so an un-lensed table would
  // be a wall of mostly-empty "—" cells. The detail modal still shows
  // all custom fields via CustomFieldsPanel.
  const allFieldDefs = fieldDefs.data?.items ?? [];
  const lensFieldDefs: PlatformFieldDef[] = lensName
    ? allFieldDefs.filter((d) => d.source_module === lensName)
    : [];
  const lensModule: OrgModuleListItem | undefined = lensName
    ? orgModules.data?.items.find((m) => m.name === lensName)
    : undefined;
  // The specialisations available to lens by — every distinct module
  // that has contributed a field-def for machines.
  const availableLenses = Array.from(
    new Set(
      allFieldDefs
        .map((d) => d.source_module)
        .filter((s): s is string => !!s),
    ),
  )
    .map((name) => ({
      name,
      label: orgModules.data?.items.find((m) => m.name === name)?.displayName ?? name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Filter machines: with a lens, show only rows that have any of
  // the lens's fields populated. Without a lens, show all.
  const allRows = machines.data?.items ?? [];
  // Tell Ask Cobb what's on this screen. Generic: a breakdown by whatever states
  // this workspace's machines actually use (no hardcoded "rebuilding" etc.).
  const machineStates = (() => {
    const by = new Map<string, number>();
    for (const m of allRows) by.set(m.state || "unset", (by.get(m.state || "unset") ?? 0) + 1);
    return [...by.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
  })();
  usePublishChatContext({
    label: instance ? `Machines (${instance})` : "Machines",
    summary: `${allRows.length} machine${allRows.length === 1 ? "" : "s"}` + (machineStates ? ` (${machineStates})` : ""),
  });
  const rows = lensName
    ? allRows.filter((m) =>
        lensFieldDefs.some((d) => {
          const v = (m.metadata as Record<string, unknown>)[d.name];
          return v !== null && v !== undefined && v !== "";
        }),
      )
    : allRows;

  const [query, setQuery] = useState("");
  // Generic, data-driven state filter: hide whatever machine states you don't
  // want to see (e.g. "shelved", or "sold"). The states come from the data
  // itself — not a hardcoded list — and your choice persists per view. (A bundle
  // can also ship a default via a saved view; this is the user-defined layer.)
  const stateKey = `cobblr.machines.hiddenStates.${instance ?? "all"}`;
  const [hiddenStates, setHiddenStates] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(stateKey) || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(stateKey, JSON.stringify([...hiddenStates]));
    } catch {
      /* private mode / quota — non-fatal */
    }
  }, [stateKey, hiddenStates]);
  const [stateMenuOpen, setStateMenuOpen] = useState(false);
  const allStates = useMemo(
    () => [...new Set(rows.map((m) => m.state).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  // Saved views (core-views). The 3D Printers bundle ships a pinned "Printer
  // fleet by state" view; users can pin their own filter+grouping as a chip.
  // Saved views are keyed on the INSTANCE kind (`<instance>:item`), NOT the base
  // `machines:machine`. That's the kind bundle install re-keys a provides_instances
  // saved_view to (bundles.ts), so it's how the shipped "Printer fleet by state"
  // view is stored — querying the base kind misses it — AND it scopes views per
  // instance (3D Printers views stay separate from Laser Cutters). A view's
  // config = { filter:{state:[...]}, group_by }.
  const viewKind = instance ? `${instance}:item` : ENTITY_KIND;
  const viewId = searchParams.get("view");
  const savedViews = useQuery({
    queryKey: ["saved-views", activeSlug, viewKind],
    queryFn: () => api.listSavedViews(activeSlug, viewKind),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const views = savedViews.data?.items ?? [];
  const activeView = viewId ? (views.find((v) => v.id === viewId) ?? null) : null;
  const viewGroupBy = (activeView?.config as { group_by?: string } | undefined)?.group_by || null;
  const viewStateFilter = (activeView?.config as { filter?: { state?: string[] } } | undefined)?.filter?.state;
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

  // An active view's state filter wins over the ad-hoc "states" dropdown (the
  // dropdown is hidden while such a view is active); otherwise the dropdown's
  // hidden set applies.
  const stateVisible = viewStateFilter
    ? rows.filter((m) => viewStateFilter.includes(m.state ?? ""))
    : hiddenStates.size
      ? rows.filter((m) => !hiddenStates.has(m.state ?? ""))
      : rows;
  const filtered = query
    ? stateVisible.filter((m) =>
        [m.name, m.manufacturer, m.family, m.type, m.short_name]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(query.toLowerCase())),
      )
    : stateVisible;

  // Group the un-lensed list by specialisation section (3D Printers /
  // Laser Cutters / CNC Machines). Each machine carries an explicit
  // `metadata.specialisation` naming its specialisation module (set
  // via the picker in the detail modal); machines with none set fall
  // into "Unspecialised". Under a lens the list is already scoped to
  // one specialisation, so it stays a single flat table.
  const lensNames = new Set(availableLenses.map((l) => l.name));
  const sectionOf = (m: Machine): string => {
    const s = (m.metadata as Record<string, unknown>)?.specialisation;
    return typeof s === "string" && lensNames.has(s) ? s : "";
  };
  const sections: { key: string; label: string; rows: Machine[] }[] = [];
  if (!lensName) {
    const byKey = new Map<string, Machine[]>();
    for (const m of filtered) {
      const k = sectionOf(m);
      const arr = byKey.get(k) ?? [];
      arr.push(m);
      byKey.set(k, arr);
    }
    for (const l of availableLenses) {
      const r = byKey.get(l.name);
      if (r?.length) sections.push({ key: l.name, label: l.label, rows: r });
    }
    const other = byKey.get("");
    if (other?.length) sections.push({ key: "", label: "Unspecialised", rows: other });
  }

  const rowClick = openDetail;
  // Is the digifab module on? Gates the per-machine "print manager" panel in the
  // detail modal — a printer can be linked to an FDM Monster/OctoPrint device
  // right from its own page when digifab is enabled (the 3D Printers bundle
  // brings both modules under one roof).
  const digifabEnabled = !!orgModules.data?.items.find((m) => m.name === "digifab")?.enabled;

  const [newOpen, setNewOpen] = useState(false);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  // 3D Printers (and any machines instance) with the Print Manager on get a live
  // "Fleet" tab right here — the cockpit (temps/progress/jobs) that otherwise only
  // lived under Configuration → Print Manager.
  // Contributed panels (manifest contributes.panels, machines-digifab-
  // unification.md §5): whatever ENABLED modules declare for this module's
  // surfaces, rendered through the panel registry — this page never names a
  // contributor. digifab's Fleet tab + Print manager arrive this way.
  const enabledModules = (orgModules.data?.items ?? []).filter((m) => m.enabled);
  const contributedTabs = enabledModules
    .flatMap((m) => m.panels ?? [])
    .filter((p) => p.surface === "module-page-tab" && p.target === "machines" && hasPageTab(p.id));
  // Persisted so the tab you're on (items vs a contributed tab) survives a
  // refresh. A stale persisted id (module disabled since) falls back to items.
  const [pageTabRaw, setPageTab] = usePersistedState<string>("machines.tab", "items");
  const pageTab = pageTabRaw !== "items" && contributedTabs.some((p) => p.id === pageTabRaw) ? pageTabRaw : "items";
  const showContributedTabs = !!instance && contributedTabs.length > 0;
  // One machine, two lenses: the registry shows each LINKED machine's live
  // status (● printing 46% / needs clearing / offline) next to its lifecycle
  // state — the fleet's view of the machine, on the machine's own card. One
  // gentle background poll for the whole page; off when digifab is disabled.
  const registryFleet = useQuery({
    queryKey: ["digifab-fleet", activeSlug],
    queryFn: () => api.getDigifabFleet(activeSlug),
    enabled: !!activeSlug && digifabEnabled && pageTab === "items",
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const liveByMachine = useMemo(() => indexFleetByMachine(registryFleet.data), [registryFleet.data]);
  const [viewMode, setViewMode] = useViewMode("machines", "list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toastM = useToast();
  const confirmM = useConfirm();
  const qcM = useQueryClient();
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        // Scope to the instance — an instance machine lives under
        // /instances/<name>/items/:id, not the default machines table, so the
        // un-scoped delete 404s ("not found").
        await api.deleteMachine(activeSlug, id, instance);
      }
    },
    onSuccess: () => {
      toastM.success(`Deleted ${selected.size} machine${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      void qcM.invalidateQueries({ queryKey: ["machines", activeSlug] });
    },
    onError: (e) => toastM.error((e as Error).message),
  });
  function toggleRow(id: string, checked: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (checked) n.add(id);
      else n.delete(id);
      return n;
    });
  }
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const bulkTag = useMutation({
    mutationFn: async (tagName: string) => {
      for (const id of Array.from(selected)) {
        await api.attachTag(activeSlug, {
          tag_name: tagName,
          source_module: "machines",
          source_type: "machine",
          source_id: id,
        });
      }
    },
    onSuccess: () => {
      toastM.success(`Tagged ${selected.size} machine${selected.size === 1 ? "" : "s"}`);
      setSelected(new Set());
      setBulkTagOpen(false);
      void qcM.invalidateQueries({ queryKey: ["machines", activeSlug] });
    },
    onError: (e) => toastM.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          {displayName ?? "machines"}
        </h1>
        {!instance && lensModule && (
          <Link
            to="/machines"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cobble-100 text-accent dark:bg-cobble-700/40 dark:text-cobble-200 text-[10px] font-mono uppercase tracking-widest hover:bg-cobble-200 transition"
            title="Clear lens"
          >
            lens: {lensModule.displayName} ×
          </Link>
        )}
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          {filtered.length} of {allRows.length}
        </span>
        {allStates.length > 1 && !viewStateFilter && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setStateMenuOpen((o) => !o)}
              className={
                "text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border transition " +
                (hiddenStates.size
                  ? "border-accent text-accent bg-accent/5"
                  : "border-line dark:border-slate-600 text-muted hover:text-accent hover:border-accent")
              }
              title="Show or hide machines by state"
            >
              {hiddenStates.size ? `states · ${hiddenStates.size} hidden` : "states"}
            </button>
            {stateMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setStateMenuOpen(false)} />
                <div className="absolute z-20 mt-1 left-0 min-w-44 max-h-72 overflow-y-auto rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg p-2 space-y-0.5">
                  <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-faint px-1 mb-1">
                    <span>show states</span>
                    {hiddenStates.size > 0 && (
                      <button type="button" onClick={() => setHiddenStates(new Set())} className="text-accent hover:underline normal-case tracking-normal">
                        reset
                      </button>
                    )}
                  </div>
                  {allStates.map((s) => {
                    const shown = !hiddenStates.has(s);
                    return (
                      <label key={s} className="flex items-center gap-2 px-1 py-0.5 text-xs cursor-pointer rounded hover:bg-subtle dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          checked={shown}
                          onChange={() =>
                            setHiddenStates((prev) => {
                              const n = new Set(prev);
                              if (shown) n.add(s);
                              else n.delete(s);
                              return n;
                            })
                          }
                        />
                        <span className="text-content dark:text-mortar-100 capitalize">{s}</span>
                        <span className="ml-auto text-faint">{rows.filter((m) => m.state === s).length}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
        {showContributedTabs && (
          <div className="inline-flex rounded-md border border-line dark:border-slate-600 overflow-hidden text-xs">
            <button type="button" onClick={() => setPageTab("items")} className={"px-2.5 py-1 " + (pageTab === "items" ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}>
              {noun}s
            </button>
            {contributedTabs.map((p) => (
              <button key={p.id} type="button" onClick={() => setPageTab(p.id)} className={"px-2.5 py-1 " + (pageTab === p.id ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}>
                {p.title}
              </button>
            ))}
          </div>
        )}
        {!instance && !lensName && availableLenses.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) navigate(`/machines?lens=${encodeURIComponent(e.target.value)}`);
            }}
            className="input !py-1 !text-xs !w-auto"
            title="Focus the table on one specialisation's fields"
          >
            <option value="">lens…</option>
            {availableLenses.map((l) => (
              <option key={l.name} value={l.name}>
                {l.label}
              </option>
            ))}
          </select>
        )}
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

      {/* Saved-view chips — one-click perspectives (the bundle's "Printer fleet
          by state", plus any you save). Only on the flat instance/lens list,
          where a view's group_by + state filter apply. */}
      {(instance || lensName) && pageTab !== "fleet" && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <MachineViewChip active={!activeView} onClick={() => selectView(null)}>
            All {noun}s
          </MachineViewChip>
          {views.map((v) => (
            <MachineViewChip key={v.id} active={activeView?.id === v.id} onClick={() => selectView(v.id)}>
              {v.name}
            </MachineViewChip>
          ))}
          <button
            type="button"
            onClick={() => setSaveViewOpen(true)}
            className="text-xs font-medium px-2.5 py-1 rounded-full border border-dashed border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-cobble-400 hover:text-accent transition inline-flex items-center gap-1"
            title="Save the current filter + grouping as a reusable view"
          >
            <Plus size={12} /> Save view
          </button>
        </div>
      )}

      {pageTab !== "items" ? (
        /* A contributed page tab (e.g. digifab's Fleet — scoped to THIS
           collection's machines; the whole-shop floor stays on /digifab).
           Rendered through the panel registry: this page doesn't know or
           care which module is behind the tab. */
        <ContributedPageTab id={pageTab} ctx={{ slug: activeSlug, itemNoun: noun, entityIds: new Set(allRows.map((m) => m.id)) }} />
      ) : filtered.length === 0 ? (
        !instance && allRows.length === 0 && (machineInstances.data?.items.length ?? 0) > 0 ? (
          <ModuleInstanceChooser instances={machineInstances.data!.items} icon={Wrench} noun={noun} />
        ) : (
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-10 text-center text-xs text-faint italic">
            {allRows.length === 0
              ? `No ${noun}s yet. Click + new to add one.`
              : "No matches with the current filters."}
          </div>
        )
      ) : viewMode === "tiles" ? (
        instance || lensName ? (
          viewGroupBy ? (
            <div className="space-y-5">
              {groupMachines(filtered, viewGroupBy).map((g) => (
                <section key={g.key}>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2 capitalize">
                    // {g.key} <span className="text-faint dark:text-slate-500">({g.rows.length})</span>
                  </div>
                  <MachineTileGrid rows={g.rows} onRowClick={rowClick} live={liveByMachine} />
                </section>
              ))}
            </div>
          ) : (
            <MachineTileGrid rows={filtered} onRowClick={rowClick} live={liveByMachine} />
          )
        ) : (
          <div className="space-y-5">
            {sections.map((s) => (
              <section key={s.key || "_other"}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
                  // {s.label}{" "}
                  <span className="text-faint dark:text-slate-500">({s.rows.length})</span>
                </div>
                <MachineTileGrid rows={s.rows} onRowClick={rowClick} live={liveByMachine} />
              </section>
            ))}
          </div>
        )
      ) : instance || lensName ? (
        viewGroupBy ? (
          <div className="space-y-5">
            {groupMachines(filtered, viewGroupBy).map((g) => (
              <section key={g.key}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2 capitalize">
                  // {g.key} <span className="text-faint dark:text-slate-500">({g.rows.length})</span>
                </div>
                <MachineTable
              instance={instance}
                  live={liveByMachine}
                  rows={g.rows}
                  lensFieldDefs={lensFieldDefs}
                  onRowClick={rowClick}
                  selected={selected}
                  onToggle={toggleRow}
                  onSelectAll={(c) =>
                    setSelected((prev) => {
                      const n = new Set(prev);
                      if (c) for (const r of g.rows) n.add(r.id);
                      else for (const r of g.rows) n.delete(r.id);
                      return n;
                    })
                  }
                />
              </section>
            ))}
          </div>
        ) : (
          <MachineTable
              instance={instance}
            live={liveByMachine}
            rows={filtered}
            lensFieldDefs={lensFieldDefs}
            onRowClick={rowClick}
            selected={selected}
            onToggle={toggleRow}
            onSelectAll={(c) =>
              setSelected(c ? new Set(filtered.map((r) => r.id)) : new Set())
            }
          />
        )
      ) : (
        <div className="space-y-5">
          {sections.map((s) => (
            <section key={s.key || "_other"}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
                // {s.label}{" "}
                <span className="text-faint dark:text-slate-500">({s.rows.length})</span>
              </div>
              <MachineTable
              instance={instance}
                live={liveByMachine}
                rows={s.rows}
                lensFieldDefs={[]}
                onRowClick={rowClick}
                selected={selected}
                onToggle={toggleRow}
                onSelectAll={(c) =>
                  setSelected((prev) => {
                    const n = new Set(prev);
                    if (c) for (const r of s.rows) n.add(r.id);
                    else for (const r of s.rows) n.delete(r.id);
                    return n;
                  })
                }
              />
            </section>
          ))}
        </div>
      )}

      <MachineDetailModal
        machineId={selectedId}
        instance={instance}
        specialisations={instance ? [] : availableLenses}
        onClose={closeDetail}
      />
      <NewMachineModal
        open={newOpen}
        instance={instance}
        noun={noun}
        digifabEnabled={digifabEnabled}
        onClose={() => setNewOpen(false)}
        onCreated={instance ? (mid) => setLocalSel(mid) : undefined}
      />
      <SaveViewModal
        open={saveViewOpen}
        slug={activeSlug}
        viewKind={viewKind}
        noun={noun}
        allStates={allStates}
        shownStates={viewStateFilter ?? allStates.filter((s) => !hiddenStates.has(s))}
        currentGroupBy={viewGroupBy}
        onClose={() => setSaveViewOpen(false)}
        onSaved={(v) => {
          setSaveViewOpen(false);
          void savedViews.refetch();
          selectView(v.id);
        }}
      />
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
                  .map((id) => allRows.find((m) => m.id === id))
                  .filter((m): m is NonNullable<typeof m> => !!m)
                  .map((m) => ({
                    slug: activeSlug,
                    entityKind: "machines:machine",
                    entityId: m.id,
                    description: m.name,
                  }));
                const { ok, fail } = await queueLabelsBulk(inputs);
                if (fail === 0) {
                  toastM.success(`Queued ${ok} label${ok === 1 ? "" : "s"}.`);
                } else {
                  toastM.error(`Queued ${ok}; ${fail} failed.`);
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
                const ok = await confirmM({
                  title: `Delete ${selected.size} machine${selected.size === 1 ? "" : "s"}?`,
                  message: "This removes the rows from the workspace permanently.",
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
        <MachineBulkTagModal
          count={selected.size}
          busy={bulkTag.isPending}
          onClose={() => setBulkTagOpen(false)}
          onSubmit={(name) => bulkTag.mutate(name)}
        />
      )}
    </div>
  );
}

function MachineViewChip({
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

/** Partition machines for a view's group_by. `state` is a native column;
 *  any other key reads from metadata. Blanks ("—") sort last. */
function groupMachines(items: Machine[], key: string): { key: string; rows: Machine[] }[] {
  const map = new Map<string, Machine[]>();
  for (const m of items) {
    const raw = key === "state" ? m.state : (m.metadata as Record<string, unknown> | null)?.[key];
    const v = raw == null || String(raw).trim() === "" ? "—" : String(raw).trim();
    if (!map.has(v)) map.set(v, []);
    map.get(v)!.push(m);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([k, rows]) => ({ key: k, rows }));
}

/** "Save as view" — persist the current state filter + optional grouping as a
 *  reusable core-views chip (kind `machines:machine`, shared across instances). */
function SaveViewModal({
  open,
  slug,
  viewKind,
  noun,
  allStates,
  shownStates,
  currentGroupBy,
  onClose,
  onSaved,
}: {
  open: boolean;
  slug: string;
  viewKind: string;
  noun: string;
  allStates: string[];
  shownStates: string[];
  currentGroupBy: string | null;
  onClose: () => void;
  onSaved: (v: SavedView) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [groupByState, setGroupByState] = useState(currentGroupBy === "state");
  const [included, setIncluded] = useState<Set<string>>(() => new Set(shownStates));
  // Re-seed from the live selection each time the modal opens.
  useEffect(() => {
    if (open) {
      setIncluded(new Set(shownStates));
      setGroupByState(currentGroupBy === "state");
      setName("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {};
      // Only persist a filter when it's a strict subset — "all states" = no filter.
      if (included.size && included.size < allStates.length) config.filter = { state: [...included] };
      if (groupByState) config.group_by = "state";
      return api.createSavedView(slug, {
        entity_kind: viewKind,
        name: name.trim(),
        view_type: "list",
        config,
      });
    },
    onSuccess: (v) => {
      toast.success(`Saved view “${v.name}”`);
      onSaved(v);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="Save as view">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && included.size) create.mutate();
        }}
        className="space-y-4"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">View name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`e.g. Active ${noun}s, By state`}
            autoFocus
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        {allStates.length > 1 && (
          <div>
            <div className="text-xs text-muted mb-1">Include states</div>
            <div className="flex flex-wrap gap-1.5">
              {allStates.map((s) => {
                const on = included.has(s);
                return (
                  <button
                    type="button"
                    key={s}
                    onClick={() =>
                      setIncluded((prev) => {
                        const n = new Set(prev);
                        if (on) n.delete(s);
                        else n.add(s);
                        return n;
                      })
                    }
                    className={
                      "text-xs px-2 py-0.5 rounded-full border capitalize transition " +
                      (on
                        ? "border-cobble-400 bg-cobble-50 dark:bg-cobble-950/30 text-accent"
                        : "border-line dark:border-slate-700 text-faint")
                    }
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-faint mt-1">
              {included.size === allStates.length
                ? "All states — no filter, shows everything"
                : `${included.size} of ${allStates.length} states`}
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={groupByState} onChange={(e) => setGroupByState(e.target.checked)} />
          <span className="text-content dark:text-mortar-100">Group by state</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || !name.trim() || included.size === 0}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {create.isPending ? "saving…" : "Save view"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MachineBulkTagModal({
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
    <Modal open onClose={onClose} title={`Tag ${count} machine${count === 1 ? "" : "s"}`}>
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
            placeholder="e.g. in-progress, voron, archive"
            className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
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

/** Live fleet chip on a registry row — the fleet's view of a linked machine,
 *  shown beside its lifecycle state (two facts, both labelled as what they are). */
function LiveChip({ dev }: { dev: DigifabFleetDevice }) {
  const c = fleetStatusChip(dev);
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted dark:text-slate-400 whitespace-nowrap" title="live print-manager status">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
      {c.label}
    </span>
  );
}

function MachineTable({
  rows,
  lensFieldDefs,
  onRowClick,
  selected,
  onToggle,
  onSelectAll,
  live,
  instance,
}: {
  instance?: string;
  rows: Machine[];
  lensFieldDefs: PlatformFieldDef[];
  onRowClick: (id: string) => void;
  selected?: Set<string>;
  onToggle?: (id: string, checked: boolean) => void;
  onSelectAll?: (checked: boolean) => void;
  /** machine_id → its linked fleet device, for the live status chip. */
  live?: Map<string, { dev: DigifabFleetDevice; connId: string }>;
}) {
  // The column header must respect a relabel too, or the list says "Manufacturer"
  // while the detail page says "Make".
  const fp = useFieldPresentation(instance ? `${instance}:item` : ENTITY_KIND);
  const showSelect = !!selected && !!onToggle;
  const allChecked = showSelect && rows.length > 0 && rows.every((r) => selected!.has(r.id));
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
          <tr>
            {showSelect && (
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => onSelectAll?.(e.target.checked)}
                  className="accent-cobble-600"
                  aria-label="Select all"
                />
              </th>
            )}
            <th className="text-left px-3 py-2">Name</th>
            <th className="text-left px-3 py-2">Family</th>
            <th className="text-left px-3 py-2">{fp.label("manufacturer", "Manufacturer")}</th>
            <th className="text-left px-3 py-2">State</th>
            {lensFieldDefs.map((d) => (
              <th key={d.id} className="text-left px-3 py-2">
                {d.display_label}
              </th>
            ))}
            <th className="text-right px-3 py-2">qty</th>
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-700">
          {rows.map((m) => (
            <tr
              key={m.id}
              onClick={() => onRowClick(m.id)}
              className="hover:bg-subtle dark:hover:bg-slate-800/40 transition cursor-pointer"
            >
              {showSelect && (
                <td
                  className="px-3 py-2 w-8"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected!.has(m.id)}
                    onChange={(e) => onToggle!(m.id, e.target.checked)}
                    className="accent-cobble-600"
                    aria-label={`Select ${m.name}`}
                  />
                </td>
              )}
              <td className="px-3 py-2 text-content dark:text-mortar-100 font-medium">
                <div className="flex items-center gap-3">
                  <EntityThumb src={m.image_path} alt={m.name} size={56} />
                  <span className="truncate">
                    {m.name}
                    {m.short_name && (
                      <span className="ml-1.5 text-[10px] font-mono text-faint">
                        {m.short_name}
                      </span>
                    )}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2 text-muted dark:text-slate-400">
                {m.family || "—"}
              </td>
              <td className="px-3 py-2 text-muted dark:text-slate-400">
                {m.manufacturer || "—"}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
                    {m.state}
                  </span>
                  {live?.get(m.id) && <LiveChip dev={live.get(m.id)!.dev} />}
                </div>
              </td>
              {lensFieldDefs.map((d) => {
                const v = (m.metadata as Record<string, unknown>)[d.name];
                return (
                  <td key={d.id} className="px-3 py-2 text-content dark:text-mortar-200 text-xs">
                    {v === null || v === undefined || v === "" ? "—" : String(v)}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right font-mono text-xs text-muted">
                {m.quantity}
              </td>
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

function MachineTileGrid({
  rows,
  onRowClick,
  live,
}: {
  rows: Machine[];
  onRowClick: (id: string) => void;
  /** machine_id → its linked fleet device, for the live status chip. */
  live?: Map<string, { dev: DigifabFleetDevice; connId: string }>;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {rows.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onRowClick(m.id)}
          className="text-left"
        >
          <EntityTile
            src={m.image_path}
            title={m.name}
            subtitle={m.family || m.manufacturer || m.short_name || null}
            badge={m.state}
          />
          {live?.get(m.id) && (
            <div className="mt-1 px-0.5">
              <LiveChip dev={live.get(m.id)!.dev} />
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function MachineDetailModal({
  machineId,
  instance,
  specialisations,
  onClose,
}: {
  machineId: string | null;
  instance?: string;
  specialisations: { name: string; label: string }[];
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const machine = useQuery({
    queryKey: ["machine", activeSlug, machineId],
    queryFn: () => api.getMachine(activeSlug, machineId!, instance),
    enabled: !!machineId,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<Machine>) => api.updateMachine(activeSlug, machineId!, patch, instance),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["machine", activeSlug, machineId] });
      void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
    },
  });
  // The machine ROW is always `machines:machine` (attachments, actions, native
  // fields), but a bundle ships its custom field defs (hotend, firmware, …) and
  // native overrides under the INSTANCE kind `<instance>:item` — that's where
  // the install writes them (bundles.ts). So in an instance we read field
  // presentation + custom fields from `<instance>:item`; values still live on
  // the machine's metadata and commit through updateMachine.
  const customKind = instance ? `${instance}:item` : ENTITY_KIND;
  // Native-field presentation: a bundle/config can relabel + show/hide these
  // native fields per workspace. No-op (fallback label, not hidden) until an
  // override exists. Same pattern as AssetsPage.
  const fp = useFieldPresentation(customKind);
  const remove = useMutation({
    mutationFn: () => api.deleteMachine(activeSlug, machineId!, instance),
    onSuccess: () => {
      toast.success("Machine deleted.");
      void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const [notesOpen, setNotesOpen] = useState(false);
  const m = machine.data;
  // Kind-aware fields: a closed-ecosystem printer (Bambu/Prusa) hides the
  // DIY build-detail block (hotend/mainboard/firmware/local-IP…); an open one
  // (Klipper/RepRap/Marlin) shows it. Resolved from metadata.printer_kind, with
  // a manufacturer fallback so printers made before the kind was persisted still
  // clean up. null kind → recognise as "not a printer" → no selector, hide nothing.
  const printerKind = m ? resolvePrinterKind(m.metadata as Record<string, unknown>, m.manufacturer) : null;
  const printerHidden = hiddenPrinterFields(printerKind);

  // Auto-fetch a product photo for a printer that has none (e.g. one connected
  // before this shipped) — once, the user does nothing; it appears on refresh.
  const enrichFired = useRef(false);
  const [autoBusy, setAutoBusy] = useState(false);
  // Manual re-fetch (the "Auto" button on the image editor): grab a fresh product
  // photo for this printer on demand, even if it already has one.
  async function runAutoFetch() {
    if (!m) return;
    setAutoBusy(true);
    try {
      // No query built here on purpose — the server derives it from the
      // machine's own name/brand/fields, the same phrase the picker and the
      // scan inbox use.
      const r = await api.enrichEntityImage(activeSlug, { entity_kind: "machines:machine", entity_id: m.id, instance }).catch(() => null);
      if (r?.image_path) {
        void qc.invalidateQueries({ queryKey: ["machine", activeSlug, machineId] });
        void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
      } else {
        toast.error("Couldn't find a photo to auto-fetch.");
      }
    } finally {
      setAutoBusy(false);
    }
  }
  // Interactive web-photo picker (the shared ImageSearchPicker) — pick a SPECIFIC
  // image instead of letting Auto choose. enrichEntityImage stores the chosen url.
  const [photoSearchOpen, setPhotoSearchOpen] = useState(false);
  const [photoPickBusy, setPhotoPickBusy] = useState(false);
  async function pickWebPhoto(url: string) {
    if (!m) return;
    setPhotoPickBusy(true);
    try {
      const r = await api
        .enrichEntityImage(activeSlug, {
          entity_kind: "machines:machine",
          entity_id: m.id,
          instance,
          image_url: url, // a picked url skips the search entirely
        })
        .catch(() => null);
      if (r?.image_path) {
        void qc.invalidateQueries({ queryKey: ["machine", activeSlug, machineId] });
        void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
        toast.success("Photo updated.");
        setPhotoSearchOpen(false);
      } else {
        toast.error("Couldn't save that image.");
      }
    } finally {
      setPhotoPickBusy(false);
    }
  }

  useEffect(() => {
    // Once per modal open; if no image lands (a transient failure), it simply
    // retries the next time the printer is opened — no permanent "tried" flag.
    if (!m || enrichFired.current) return;
    if (printerKind === null || m.image_path) return;
    const q = [m.manufacturer, m.family, "3D printer"].filter(Boolean).join(" ");
    if (!q.replace("3D printer", "").trim()) return;
    enrichFired.current = true;
    // Await the result and refetch so the photo appears LIVE in the open modal —
    // no need to close/refresh.
    void (async () => {
      const r = await api.enrichEntityImage(activeSlug, { entity_kind: "machines:machine", entity_id: m.id, query: q, instance }).catch(() => null);
      if (r?.image_path) {
        void qc.invalidateQueries({ queryKey: ["machine", activeSlug, machineId] });
        void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
      }
    })();
  }, [m, printerKind, activeSlug, instance, qc, machineId]);

  async function handleDelete() {
    if (!m) return;
    const ok = await confirm({
      title: `Delete "${m.name}"?`,
      message: "This can't be undone. Pairings referencing this machine will be orphaned.",
      confirmLabel: "Delete machine",
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  // Honor the same hide overrides the fields do — a lean instance that hid
  // manufacturer/state shouldn't leak them back in the header subtitle.
  const subtitle = m
    ? [
        !fp.hidden("manufacturer") && m.manufacturer ? m.manufacturer : null,
        !fp.hidden("state") && m.state ? m.state : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined
    : undefined;

  return (
    <Modal
      open={!!machineId}
      onClose={onClose}
      title={m?.name ?? "loading…"}
      subtitle={subtitle}
      size="xl"
    >
      {m ? (
        <div className="space-y-3">
          {/* Wide record layout (same shape as the assets detail): the photo
              large on the LEFT with its picker, everything else on the RIGHT,
              so the modal uses width instead of scrolling tall. Stacks on
              phones. */}
          <div className="grid gap-6 md:grid-cols-[minmax(180px,240px)_1fr]">
            <div className="space-y-2">
              <EntityImageEdit
                slug={activeSlug}
                src={m.image_path}
                alt={m.name}
                size={220}
                onChange={(image_path) => update.mutate({ image_path })}
                onAutoFetch={printerKind !== null ? runAutoFetch : undefined}
                autoBusy={autoBusy}
              />
              {/* Universal web-image picker — pick the machine's photo from a web search. */}
              <div>
                <button
                  type="button"
                  onClick={() => setPhotoSearchOpen((v) => !v)}
                  className="text-[10px] font-mono uppercase tracking-widest text-accent hover:underline"
                >
                  {photoSearchOpen ? "hide photo search" : "search the web for a photo"}
                </button>
                {photoSearchOpen && (
                  <div className="mt-1.5">
                    {/* Derived mode: the server builds the phrase from this
                        machine's own name + brand + fields, identically to the
                        scan inbox. The old hand-built query (manufacturer +
                        family + a literal "3D printer") is gone — one
                        derivation, one behaviour. */}
                    <ImageSearchPicker
                      entity={{ kind: ENTITY_KIND, id: m.id }}
                      brand={m.manufacturer ?? undefined}
                      busy={photoPickBusy}
                      onPick={pickWebPhoto}
                      label="pick a photo"
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="min-w-0 space-y-3">
            <div className="space-y-2">
              <EntityActionsBar entityKind={ENTITY_KIND} entityId={m.id} />
              <div className="flex flex-wrap gap-3">
                {printerKind !== null && (
                  <label className="block">
                    <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Kind</span>
                    <select
                      value={typeof m.metadata?.printer_kind === "string" ? (m.metadata.printer_kind as string) : printerKind}
                      onChange={(e) => update.mutate({ metadata: { ...m.metadata, printer_kind: e.target.value } })}
                      className="input !w-auto !py-1 text-xs"
                    >
                      {PRINTER_KIND_OPTIONS.map((k) => (<option key={k.id} value={k.id}>{k.label}</option>))}
                    </select>
                  </label>
                )}
                {specialisations.length > 0 && (
                  <label className="block">
                    <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Specialisation</span>
                    <select
                      value={typeof m.metadata?.specialisation === "string" ? (m.metadata.specialisation as string) : ""}
                      onChange={(e) => update.mutate({ metadata: { ...m.metadata, specialisation: e.target.value || null } })}
                      className="input !w-auto !py-1 text-xs"
                    >
                      <option value="">— unspecialised —</option>
                      {specialisations.map((s) => (<option key={s.name} value={s.name}>{s.label}</option>))}
                    </select>
                  </label>
                )}
              </div>
            </div>

          <dl className="grid grid-cols-2 gap-3 text-xs">
            <EditField label={fp.label("name", "Name")} value={m.name} onCommit={(v) => update.mutate({ name: v })} />
            {/* Short name + Type are low-signal — show only when set (keeps the default compact). */}
            {!fp.hidden("short_name") && (m.short_name || !instance) && <EditField label={fp.label("short_name", "Short name")} value={m.short_name ?? ""} onCommit={(v) => update.mutate({ short_name: v || null })} />}
            {!fp.hidden("family") && <EditField label={fp.label("family", "Family")} value={m.family ?? ""} onCommit={(v) => update.mutate({ family: v || null })} />}
            {!fp.hidden("type") && (m.type || !instance) && <EditField label={fp.label("type", "Type")} value={m.type ?? ""} onCommit={(v) => update.mutate({ type: v || null })} />}
            {!fp.hidden("manufacturer") && <EditField label={fp.label("manufacturer", "Manufacturer")} value={m.manufacturer ?? ""} onCommit={(v) => update.mutate({ manufacturer: v || null })} />}
            {!fp.hidden("serial_number") && (m.serial_number || !instance) && <EditField label={fp.label("serial_number", "Serial number")} value={m.serial_number ?? ""} onCommit={(v) => update.mutate({ serial_number: v || null })} />}
            {!fp.hidden("state") && (
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{fp.label("state", "State")}</span>
                <select value={m.state} onChange={(e) => update.mutate({ state: e.target.value })} className="input">
                  {m.state && !MACHINE_STATES.includes(m.state) && <option value={m.state}>{m.state}</option>}
                  {MACHINE_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                </select>
              </label>
            )}
            {/* Quantity is an inventory-ism — a tracked machine (printer/laser/CNC) is one unit. Hide for specialised instances. */}
            {!fp.hidden("quantity") && !instance && <EditField label={fp.label("quantity", "Quantity")} value={String(m.quantity)} numeric onCommit={(v) => update.mutate({ quantity: Number(v) || 0 })} />}
            <LocationPicker label="Location" kind="area" value={m.location_id} onChange={(id) => update.mutate({ location_id: id })} size="sm" />
          </dl>

          {/* Custom fields render inline (they self-collapse empty ones, and are
              null entirely for a closed printer once hideNames strips them). */}
          <CustomFieldsPanel
            entityKind={customKind}
            entityId={m.id}
            values={m.metadata}
            hideNames={printerHidden}
            onCommit={(name, value) => update.mutate({ metadata: { ...m.metadata, [name]: value } })}
          />

          {/* What's installed inside this machine (a printer's mods/parts). The
              generic placement panel — same one a server asset or a drawer uses. */}
          <ContentsPanel slug={activeSlug} container={{ kind: "machines:machine", id: m.id }} title="Installed components" />

          {/* Contributed detail panels (e.g. digifab's Print manager) — the
              panel registry renders whatever enabled modules declare for
              machines:machine; this modal names no contributor. */}
          <ContributedDetailPanels
            target="machines:machine"
            ctx={{
              slug: activeSlug,
              entityId: m.id,
              entityTitle: m.name,
              hints: { printer_kind: typeof m.metadata?.printer_kind === "string" ? (m.metadata.printer_kind as string) : undefined },
            }}
          />

          {/* Secondary stuff stays out of the way: small add-pills (Tag / File /
              Link / Note) that only grow into full fields once used — so the
              modal opens without a wall of empty boxes. */}
          <div className="flex flex-wrap items-start gap-2">
            <EntityAttachments kind={ENTITY_KIND} entityId={m.id} compact />
            {!(m.notes || notesOpen) && (
              <button
                type="button"
                onClick={() => setNotesOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-dashed border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition"
              >
                <Plus size={10} /> Note
              </button>
            )}
          </div>
          {(m.notes || notesOpen) && (
            <EditField label="Notes" value={m.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />
          )}
            </div>
          </div>

          <div className="pt-3 border-t border-line dark:border-slate-700 flex items-center justify-between">
            <button
              onClick={handleDelete}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> delete machine
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-faint">loading…</div>
      )}
    </Modal>
  );
}

function NewMachineModal({
  open,
  onClose,
  instance,
  noun,
  onCreated,
  digifabEnabled,
}: {
  open: boolean;
  onClose: () => void;
  instance?: string;
  noun?: string;
  onCreated?: (id: string) => void;
  digifabEnabled?: boolean;
}) {
  // A bundle relabels this per kind (Vehicles: manufacturer -> "Make"). Hardcode it
  // and the workspace's own rename never reaches this form.
  const fp = useFieldPresentation(instance ? `${instance}:item` : ENTITY_KIND);
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [family, setFamily] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  // The two-question printer flow: (1) what kind / how does it talk, (2) how to
  // connect — flexible: directly (Bambu API today) OR through a manager.
  const [view, setView] = useState<"form" | "bambu" | "direct" | "edge">("form");
  const [kind, setKind] = useState("");
  const [connect, setConnect] = useState<"later" | "bambu_direct" | "manager" | "direct" | "edge">("later");
  const [bambuConn, setBambuConn] = useState<DigifabConnection | null>(null);
  const [bambuDevices, setBambuDevices] = useState<BambuDiscoveredDevice[]>([]);
  const [bambuDevId, setBambuDevId] = useState("");
  const [acctId, setAcctId] = useState(""); // selected Bambu account (when several are connected)
  const [mgrConnId, setMgrConnId] = useState("");
  const [mgrDeviceId, setMgrDeviceId] = useState("");
  // Inline direct-connect (Duet/OctoPrint/Klipper/PrusaLink) — the just-created connection + its devices.
  const [directConn, setDirectConn] = useState<DigifabConnection | null>(null);
  const [directDevices, setDirectDevices] = useState<DigifabDevice[]>([]);
  const [directDeviceId, setDirectDeviceId] = useState("");
  useEffect(() => {
    if (open) {
      setName(""); setManufacturer(""); setFamily(""); setLocationId(null);
      setView("form"); setKind(""); setConnect("later");
      setBambuConn(null); setBambuDevices([]); setBambuDevId(""); setAcctId("");
      setMgrConnId(""); setMgrDeviceId("");
      setDirectConn(null); setDirectDevices([]); setDirectDeviceId("");
    }
  }, [open]);

  // Printer kinds that connect over plain HTTP via a catalog (declarative) driver
  // → an inline direct-connect flow (install + create + test), like Bambu's wizard.
  const KIND_DRIVER: Record<string, string> = { klipper: "klipper-moonraker", prusa: "prusalink", reprap: "duet-rrf", marlin: "octoprint" };
  const authCfgQ = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig(), staleTime: 5 * 60_000 });

  // Existing manager connections (for the "through a manager" path).
  const conns = useQuery({
    queryKey: ["digifab-connections", activeSlug],
    queryFn: () => api.listDigifabConnections(activeSlug),
    enabled: open && !!digifabEnabled,
  });
  const connections = conns.data?.items ?? [];
  const mgrDevices = useQuery({
    queryKey: ["digifab-devices", activeSlug, mgrConnId],
    queryFn: () => api.listDigifabDevices(activeSlug, mgrConnId),
    enabled: !!mgrConnId,
  });

  // Already signed into a Bambu account (e.g. when the first printer was added)?
  // Reuse it — a Bambu connection IS the account; listDevices returns every
  // printer on it — so a second printer never re-logs in; it just picks from the
  // account's not-yet-added printers.
  const printerFlow = !!instance && !!digifabEnabled;
  // A Bambu connection IS an account. Multiple accounts can be connected at once
  // (each login = its own connection), so the add-printer flow lets you choose
  // WHICH account and then which of its not-yet-added printers.
  const bambuConns = useMemo(() => connections.filter((c) => c.type === "bambu"), [connections]);
  const reuseEnabled = open && printerFlow && connect === "bambu_direct" && bambuConns.length > 0;
  useEffect(() => {
    // Default to the first connected account once we enter the Bambu-direct path.
    if (reuseEnabled && !acctId && !bambuConn && bambuConns[0]) setAcctId(bambuConns[0].id);
  }, [reuseEnabled, acctId, bambuConn, bambuConns]);
  const bambuAcctDevices = useQuery({
    queryKey: ["digifab-devices", activeSlug, acctId],
    queryFn: () => api.listDigifabDevices(activeSlug, acctId),
    enabled: reuseEnabled && !!acctId,
  });
  const allLinks = useQuery({
    queryKey: ["digifab-links", activeSlug],
    queryFn: () => api.listDigifabLinks(activeSlug),
    enabled: reuseEnabled,
  });
  // Adopt the SELECTED account's printers that aren't already linked to a machine
  // — re-runs when you switch accounts. Skips the wizard-populated case (where
  // bambuConn already matches acctId and carries richer model info). Maps into the
  // same BambuDiscoveredDevice shape the wizard uses → picker/link/prefill unchanged.
  useEffect(() => {
    if (!reuseEnabled || !acctId) return;
    if (bambuConn && bambuConn.id === acctId) return; // already adopted / wizard-set
    if (bambuAcctDevices.isLoading || allLinks.isLoading) return;
    // Token expired / account unreachable → don't fake "all added"; let the user re-login.
    if (bambuAcctDevices.isError) return;
    const chosen = bambuConns.find((c) => c.id === acctId);
    if (!chosen) return;
    const linked = new Set((allLinks.data?.items ?? []).filter((l) => l.connection_id === acctId).map((l) => l.remote_device_id));
    const mapped: BambuDiscoveredDevice[] = (bambuAcctDevices.data?.items ?? [])
      .filter((d) => !linked.has(d.id))
      .map((d) => ({ dev_id: d.id, name: d.name, online: d.state ? !/offline/i.test(d.state) : true }));
    setBambuConn(chosen);
    setBambuDevices(mapped);
    const first = mapped.find((d) => d.online)?.dev_id ?? mapped[0]?.dev_id ?? "";
    setBambuDevId(first);
    if (first) prefillFromBambu(first, mapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reuseEnabled, acctId, bambuConn, bambuAcctDevices.dataUpdatedAt, allLinks.dataUpdatedAt]);

  // One-click turn-on for the Print Manager (digifab) when it's off.
  const enableDigifab = useMutation({
    mutationFn: () => api.enableModule(activeSlug, "digifab"),
    onSuccess: () => {
      toast.success("Print Manager enabled.");
      for (const k of ["org-modules", "modules", "nav-modules"]) {
        void qc.invalidateQueries({ queryKey: [k, activeSlug] });
      }
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't enable."),
  });

  const KINDS: { id: string; label: string; manufacturer?: string; sub: string }[] = [
    { id: "bambu", label: "Bambu Lab", manufacturer: "Bambu Lab", sub: "Bambu's app / cloud" },
    { id: "klipper", label: "Klipper", sub: "Voron, RatRig, most DIY" },
    { id: "prusa", label: "Prusa", manufacturer: "Prusa", sub: "PrusaLink / Connect" },
    { id: "reprap", label: "RepRapFirmware", sub: "Duet, via Duet Web Control" },
    { id: "marlin", label: "Marlin / other", sub: "via OctoPrint" },
    { id: "other", label: "Not sure", sub: "set it up later" },
  ];
  // On a hosted Cobblr a LAN machine can't be reached directly → default those
  // kinds to the edge-bridge path; on a self-hosted LAN, direct connect works.
  const hosted = !!authCfgQ.data?.hosted;
  function pickKind(k: string) {
    setKind(k);
    const def = KINDS.find((x) => x.id === k);
    if (def?.manufacturer && !manufacturer.trim()) setManufacturer(def.manufacturer);
    setConnect(k === "bambu" ? "bambu_direct" : KIND_DRIVER[k] ? (hosted ? "edge" : "direct") : k === "other" ? "later" : "manager");
  }
  function onEdgeConnected(connId?: string) {
    // The bridge is online + its connection exists — fall into the manager
    // device-pick path (listDevices now runs over the tunnel) to finish + link.
    if (connId) setMgrConnId(connId);
    void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
    setConnect("manager");
    setView("form");
  }
  // When a manager + its printer resolve: auto-pick the printer if there's just
  // one (so the link actually fires on Create — not left "loading…"), and
  // back-propagate a name to the empty NAME field. For an edge bridge that's the
  // name you gave the machine (the connection label); for a farm manager it's the
  // printer's reported name.
  useEffect(() => {
    if (connect !== "manager" || !mgrConnId) return;
    const devs = mgrDevices.data?.items ?? [];
    if (!mgrDeviceId && devs.length === 1 && devs[0]) setMgrDeviceId(devs[0].id);
    const conn = connections.find((c) => c.id === mgrConnId);
    const dev = devs.find((d) => d.id === mgrDeviceId) ?? (devs.length === 1 ? devs[0] : undefined);
    const candidate = conn?.type === "edge_adapter" ? conn?.label : dev?.name || conn?.label;
    if (candidate) setName((n) => n.trim() || candidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, mgrConnId, mgrDeviceId, mgrDevices.dataUpdatedAt]);
  function onDirectConnected(conn: DigifabConnection, devices: DigifabDevice[]) {
    setDirectConn(conn);
    setDirectDevices(devices);
    const first = devices[0]?.id ?? "";
    setDirectDeviceId(first);
    const dev = devices.find((d) => d.id === first);
    if (dev) setName((n) => n.trim() || dev.name);
    setConnect("direct");
    setView("form");
  }
  function onBambuConnected(c: DigifabConnection, devices: BambuDiscoveredDevice[]) {
    setBambuConn(c);
    setBambuDevices(devices);
    setAcctId(c.id); // make the just-added account the selected one
    // Surface the new account in the connections list (so the account dropdown
    // includes it when there's now more than one).
    void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
    const first = devices.find((d) => d.online)?.dev_id ?? devices[0]?.dev_id ?? "";
    setBambuDevId(first);
    prefillFromBambu(first, devices);
    setConnect("bambu_direct");
    setView("form");
  }
  function prefillFromBambu(devId: string, list = bambuDevices) {
    const d = list.find((x) => x.dev_id === devId);
    if (!d) return;
    setName((n) => n.trim() || d.name);
    setManufacturer("Bambu Lab");
    if (d.model) setFamily((f) => f.trim() || d.model!);
  }

  const create = useMutation({
    mutationFn: async () => {
      const m = await api.createMachine(
        activeSlug,
        {
          name: name.trim(), manufacturer: manufacturer.trim() || null, family: family.trim() || null, location_id: locationId,
          // Persist the chosen kind so the detail form can hide fields the kind
          // doesn't need (a Bambu hides hotend/mainboard/firmware/local-IP).
          ...(printerFlow && kind ? { metadata: { printer_kind: kind } } : {}),
        },
        instance,
      );
      // Apply the chosen print-manager link (best-effort — the machine is created
      // regardless; a link failure is surfaced but doesn't lose the machine).
      try {
        if (connect === "bambu_direct" && bambuConn && bambuDevId) {
          const dev = bambuDevices.find((d) => d.dev_id === bambuDevId);
          await api.createDigifabLink(activeSlug, { connection_id: bambuConn.id, remote_device_id: bambuDevId, remote_device_name: dev?.name ?? null, machine_id: m.id, machine_label: name.trim() });
        } else if (connect === "manager" && mgrConnId && mgrDeviceId) {
          const dev = (mgrDevices.data?.items ?? []).find((d) => d.id === mgrDeviceId);
          await api.createDigifabLink(activeSlug, { connection_id: mgrConnId, remote_device_id: mgrDeviceId, remote_device_name: dev?.name ?? null, machine_id: m.id, machine_label: name.trim() });
        } else if (connect === "direct" && directConn && directDeviceId) {
          const dev = directDevices.find((d) => d.id === directDeviceId);
          await api.createDigifabLink(activeSlug, { connection_id: directConn.id, remote_device_id: directDeviceId, remote_device_name: dev?.name ?? null, machine_id: m.id, machine_label: name.trim() });
        }
      } catch (e) {
        toast.error(`Printer created, but linking failed: ${e instanceof ApiError ? e.message : String(e)}`);
      }
      return m;
    },
    onSuccess: (m) => {
      toast.success(`${(noun ?? "machine").charAt(0).toUpperCase()}${(noun ?? "machine").slice(1)} added.`);
      void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["digifab-links", activeSlug] });
      // Auto-fetch a product photo for a new printer — the user does nothing; it
      // appears on the next refresh. Best-effort, only with something to search.
      if (printerFlow && kind && kind !== "other") {
        const q = [m.manufacturer, m.family, "3D printer"].filter(Boolean).join(" ");
        if (q.replace("3D printer", "").trim()) {
          void (async () => {
            const r = await api.enrichEntityImage(activeSlug, { entity_kind: "machines:machine", entity_id: m.id, query: q, instance }).catch(() => null);
            if (r?.image_path) {
              void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
              void qc.invalidateQueries({ queryKey: ["machine", activeSlug, m.id] });
            }
          })();
        }
      }
      onClose();
      if (onCreated) onCreated(m.id);
      else navigate(`/machines/${m.id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  const lblCls = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const segBtn = (active: boolean) =>
    "px-2.5 py-1 rounded border text-xs transition " + (active ? "border-cobble-500 text-accent bg-subtle dark:bg-slate-800" : "border-line dark:border-slate-600 text-muted hover:text-content");

  const kindLabel = KINDS.find((x) => x.id === kind)?.label ?? "printer";

  // A clear way back to the previous step in these multi-step sub-flows — distinct
  // from Cancel/✕, which exit the whole New-machine modal.
  const backToForm = (
    <button type="button" onClick={() => setView("form")} className="-mt-1 mb-3 inline-flex items-center gap-1 text-xs text-accent hover:underline">
      ← Back
    </button>
  );
  // The Bambu cloud-login wizard takes over the modal body when launched.
  if (view === "bambu") {
    return (
      <Modal open={open} onClose={onClose} title="Connect Bambu" size="sm">
        {backToForm}
        <BambuConnectWizard onConnected={onBambuConnected} onCancel={onClose} />
      </Modal>
    );
  }
  // Inline direct-connect for a network printer (Duet/OctoPrint/Klipper/PrusaLink).
  if (view === "direct" && KIND_DRIVER[kind]) {
    return (
      <Modal open={open} onClose={onClose} title={`Connect ${kindLabel}`} size="sm">
        {backToForm}
        <DirectManagerConnect driverId={KIND_DRIVER[kind]} kindLabel={kindLabel} defaultLabel={name.trim() || kindLabel} onConnected={onDirectConnected} onCancel={onClose} />
      </Modal>
    );
  }
  // Install the on-site edge connector, inline — the smooth way to finish a LAN
  // machine on a hosted Cobblr without leaving this flow.
  if (view === "edge") {
    // Pre-select the bridge driver from the kind (Klipper→moonraker, Prusa→prusalink, Duet→duet).
    const KIND_BRIDGE: Record<string, string> = { klipper: "moonraker", prusa: "prusalink", reprap: "duet" };
    return (
      <Modal open={open} onClose={onClose} title="Install the edge connector" size="md">
        {backToForm}
        <EdgeBridgeSetup presetDriver={KIND_BRIDGE[kind]} presetName={name} onCreated={onEdgeConnected} onClose={onClose} />
      </Modal>
    );
  }

  // Order the connect choices so the one that actually works comes first: on a
  // hosted Cobblr that's the edge bridge for a LAN kind; on self-host it's direct.
  const connectOptions = (kind === "bambu"
    ? [["bambu_direct", "Directly through Bambu API"], ["manager", "Through a manager"], ["later", "Set up later"]]
    : KIND_DRIVER[kind]
    ? (hosted
        ? [["edge", "Via an edge bridge"], ["direct", "Direct (same network)"], ["manager", "Through a manager"], ["later", "Set up later"]]
        : [["direct", "Connect directly"], ["edge", "Via an edge bridge"], ["manager", "Through a manager"], ["later", "Set up later"]])
    : [["manager", "Through a manager"], ["later", "Set up later"]]) as [typeof connect, string][];

  return (
    <Modal open={open} onClose={onClose} title={`New ${noun ?? "machine"}`} size="sm">
      <form onSubmit={submit} className="space-y-3">
        {printerFlow && (
          <div>
            <span className={lblCls}>What kind of printer is this?</span>
            <div className="grid grid-cols-2 gap-1.5">
              {KINDS.map((k) => (
                <button key={k.id} type="button" onClick={() => pickKind(k.id)}
                  className={"text-left px-2.5 py-1.5 rounded border transition " + (kind === k.id ? "border-cobble-500 bg-subtle dark:bg-slate-800" : "border-line dark:border-slate-600 hover:border-cobble-400")}>
                  <div className="text-sm text-content dark:text-mortar-100">{k.label}</div>
                  <div className="text-[10px] text-faint">{k.sub}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="block">
          <span className={lblCls}>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
        </label>
        <label className="block">
          <span className={lblCls}>{fp.label("manufacturer", "Manufacturer")}</span>
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className={lblCls}>Family (e.g. "Voron", "Railcore")</span>
          <input value={family} onChange={(e) => setFamily(e.target.value)} className="input" />
        </label>
        <LocationPicker label="Location" kind="area" value={locationId} onChange={setLocationId} />

        {instance && !digifabEnabled && (
          <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/30 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
              <Printer size={12} /> Print manager
            </div>
            <p className="text-[11px] text-muted dark:text-slate-400">
              Want to send prints to this {noun ?? "machine"}? Turn on the Print Manager to connect to Bambu, FDM Monster, or OctoPrint.
            </p>
            <button type="button" onClick={() => enableDigifab.mutate()} disabled={enableDigifab.isPending}
              className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5">
              {enableDigifab.isPending ? "enabling…" : "Enable Print Manager"}
            </button>
          </div>
        )}

        {printerFlow && kind && (
          <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/30 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
              <Printer size={12} /> How do you want to connect?
            </div>
            <div className="flex flex-wrap gap-1.5">
              {connectOptions.map(([v, l]) => (
                <button key={v} type="button" onClick={() => setConnect(v)} className={segBtn(connect === v)}>{l}</button>
              ))}
            </div>

            {connect === "bambu_direct" && (
              bambuConns.length === 0 && !bambuConn ? (
                <button type="button" onClick={() => setView("bambu")} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-2.5 py-1.5">
                  Connect Bambu account →
                </button>
              ) : (
                <div className="space-y-1.5">
                  {/* Several accounts connected → pick which one. A connection IS an account. */}
                  {bambuConns.length > 1 && (
                    <label className="block">
                      <span className={lblCls}>Bambu account</span>
                      <select value={acctId} onChange={(e) => { setAcctId(e.target.value); setBambuDevId(""); }} className="input !py-1 !text-xs">
                        {bambuConns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </label>
                  )}
                  {!bambuConn || bambuConn.id !== acctId ? (
                    <p className="text-[11px] text-muted dark:text-slate-400">Loading your Bambu printers…</p>
                  ) : bambuDevices.length === 0 ? (
                    <p className="text-[11px] text-muted dark:text-slate-400">
                      ✓ Using <span className="text-content dark:text-mortar-100">{bambuConn.label}</span> — every printer on this account is already added.
                    </p>
                  ) : (
                    <div>
                      <span className={lblCls}>Which printer is this?</span>
                      {/* A single printer is pre-selected; pick one to select + pre-fill. */}
                      <BambuPrinterPicker devices={bambuDevices} selectedDevId={bambuDevId} onSelect={(id) => { setBambuDevId(id); prefillFromBambu(id); }} />
                      <span className="mt-1 block text-[10px] text-emerald-600 dark:text-emerald-400">✓ Using {bambuConn.label} — name pre-filled.</span>
                    </div>
                  )}
                  <button type="button" onClick={() => setView("bambu")} className="text-[10px] text-accent hover:underline">
                    + Connect another Bambu account
                  </button>
                </div>
              )
            )}

            {connect === "direct" && (
              !directConn ? (
                <button type="button" onClick={() => setView("direct")} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-2.5 py-1.5">
                  Connect your {kindLabel} →
                </button>
              ) : directDevices.length === 0 ? (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Saved {directConn.label}, but Cobblr couldn't reach a printer there — it'll still create, and you can fix the address in the Print Manager.{" "}
                  <button type="button" onClick={() => { setDirectConn(null); setView("direct"); }} className="text-accent hover:underline">Try again →</button>
                </p>
              ) : (
                <div>
                  {directDevices.length > 1 && (
                    <label className="block">
                      <span className={lblCls}>Which printer is this?</span>
                      <select value={directDeviceId} onChange={(e) => { setDirectDeviceId(e.target.value); const d = directDevices.find((x) => x.id === e.target.value); if (d) setName((n) => n.trim() || d.name); }} className="input !py-1 !text-xs">
                        {directDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </label>
                  )}
                  <span className="mt-1 block text-[10px] text-emerald-600 dark:text-emerald-400">✓ {directConn.label} connected.</span>
                </div>
              )
            )}

            {connect === "edge" && (
              <div className="space-y-1">
                <p className="text-[11px] text-muted dark:text-slate-400">
                  Cobblr is hosted, so it can't reach this {kindLabel} on your network directly. Run a tiny bridge at your site — it dials out, no firewall changes.
                </p>
                <button type="button" onClick={() => setView("edge")} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white text-xs px-2.5 py-1.5">
                  Install the edge connector →
                </button>
              </div>
            )}

            {connect === "manager" && (
              connections.length === 0 ? (
                <p className="text-[11px] text-muted dark:text-slate-400">
                  No managers connected yet.{" "}
                  <Link to="/digifab" className="text-accent hover:underline" onClick={onClose}>Set one up →</Link>
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className={lblCls}>Manager</span>
                    <select value={mgrConnId} onChange={(e) => { setMgrConnId(e.target.value); setMgrDeviceId(""); }} className="input !py-1 !text-xs !w-auto">
                      <option value="">choose…</option>
                      {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </label>
                  {mgrConnId && (
                    <label className="block">
                      <span className={lblCls}>Printer</span>
                      <select value={mgrDeviceId} onChange={(e) => setMgrDeviceId(e.target.value)} className="input !py-1 !text-xs !w-auto" disabled={mgrDevices.isLoading}>
                        <option value="">{mgrDevices.isLoading ? "loading…" : "choose…"}</option>
                        {(mgrDevices.data?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )
            )}
          </div>
        )}

        {!instance && (
          <p className="text-[10px] text-faint">
            Want make/model fields — hotend, firmware, bed size, etc.? Add a specialization for your machine type from the{" "}
            <Link to="/bundles" className="text-accent hover:underline">marketplace</Link>{" "}
            (e.g. “3D Printers”) and they’ll show up here.
          </p>
        )}
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
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  numeric?: boolean;
  multiline?: boolean;
}) {
  const Cmp = multiline ? "textarea" : "input";
  return (
    <label className={"block " + (multiline ? "col-span-2" : "")}>
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      <Cmp
        type={numeric ? "number" : "text"}
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
