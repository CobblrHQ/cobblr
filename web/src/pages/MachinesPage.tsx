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

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Printer, Search, Tag as TagIcon, Trash2 } from "lucide-react";
import { queueLabelsBulk } from "../lib/queue-label";
import { ApiError, api, type Machine, type OrgModuleListItem, type PlatformFieldDef } from "../lib/api";
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

const ENTITY_KIND = "machines:machine";

export function MachinesPage() {
  usePageTitle("Machines");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const lensName = searchParams.get("lens");

  const machines = useQuery({
    queryKey: ["machines", activeSlug],
    queryFn: () => api.listMachines(activeSlug),
    enabled: !!activeSlug,
  });
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", activeSlug, ENTITY_KIND],
    queryFn: () => api.listFieldDefs(activeSlug, ENTITY_KIND),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const orgModules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
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
        [m.name, m.manufacturer, m.family, m.type, m.short_name]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(query.toLowerCase())),
      )
    : rows;

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

  const rowClick = (mid: string) =>
    navigate(`/machines/${mid}${searchParams.toString() ? `?${searchParams}` : ""}`);

  const [newOpen, setNewOpen] = useState(false);
  const [viewMode, setViewMode] = useViewMode("machines", "list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toastM = useToast();
  const confirmM = useConfirm();
  const qcM = useQueryClient();
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api.deleteMachine(activeSlug, id);
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
          machines
        </h1>
        {lensModule && (
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
        {!lensName && availableLenses.length > 0 && (
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
          <Plus size={14} /> New machine
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-10 text-center text-xs text-faint italic">
          {allRows.length === 0
            ? "No machines yet. Click + new to add one."
            : "No matches with the current filters."}
        </div>
      ) : viewMode === "tiles" ? (
        lensName ? (
          <MachineTileGrid rows={filtered} onRowClick={rowClick} />
        ) : (
          <div className="space-y-5">
            {sections.map((s) => (
              <section key={s.key || "_other"}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
                  // {s.label}{" "}
                  <span className="text-faint dark:text-slate-500">({s.rows.length})</span>
                </div>
                <MachineTileGrid rows={s.rows} onRowClick={rowClick} />
              </section>
            ))}
          </div>
        )
      ) : lensName ? (
        <MachineTable
          rows={filtered}
          lensFieldDefs={lensFieldDefs}
          onRowClick={rowClick}
          selected={selected}
          onToggle={toggleRow}
          onSelectAll={(c) =>
            setSelected(c ? new Set(filtered.map((r) => r.id)) : new Set())
          }
        />
      ) : (
        <div className="space-y-5">
          {sections.map((s) => (
            <section key={s.key || "_other"}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
                // {s.label}{" "}
                <span className="text-faint dark:text-slate-500">({s.rows.length})</span>
              </div>
              <MachineTable
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
        machineId={id ?? null}
        specialisations={availableLenses}
        onClose={() => navigate(`/machines${searchParams.toString() ? `?${searchParams}` : ""}`)}
      />
      <NewMachineModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
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

function MachineTable({
  rows,
  lensFieldDefs,
  onRowClick,
  selected,
  onToggle,
  onSelectAll,
}: {
  rows: Machine[];
  lensFieldDefs: PlatformFieldDef[];
  onRowClick: (id: string) => void;
  selected?: Set<string>;
  onToggle?: (id: string, checked: boolean) => void;
  onSelectAll?: (checked: boolean) => void;
}) {
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
            <th className="text-left px-3 py-2">Manufacturer</th>
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
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
                  {m.state}
                </span>
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
}: {
  rows: Machine[];
  onRowClick: (id: string) => void;
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
        </button>
      ))}
    </div>
  );
}

function MachineDetailModal({
  machineId,
  specialisations,
  onClose,
}: {
  machineId: string | null;
  specialisations: { name: string; label: string }[];
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const machine = useQuery({
    queryKey: ["machine", activeSlug, machineId],
    queryFn: () => api.getMachine(activeSlug, machineId!),
    enabled: !!machineId,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<Machine>) => api.updateMachine(activeSlug, machineId!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["machine", activeSlug, machineId] });
      void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
    },
  });
  // Native-field presentation: a bundle/config can relabel + show/hide these
  // native fields per workspace. No-op (fallback label, not hidden) until an
  // override exists. Same pattern as AssetsPage.
  const fp = useFieldPresentation(ENTITY_KIND);
  const remove = useMutation({
    mutationFn: () => api.deleteMachine(activeSlug, machineId!),
    onSuccess: () => {
      toast.success("Machine deleted.");
      void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const m = machine.data;
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

  return (
    <Modal
      open={!!machineId}
      onClose={onClose}
      title={m?.name ?? "loading…"}
      subtitle={m ? `${m.manufacturer ?? "—"} · ${m.state}` : undefined}
      size="lg"
    >
      {m ? (
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <EntityThumb
              src={m.image_path}
              alt={m.name}
              size={128}
              className="ring-1 ring-line dark:ring-slate-700"
            />
            <div className="flex-1 flex items-center gap-2">
              <EntityActionsBar entityKind={ENTITY_KIND} entityId={m.id} />
            </div>
          </div>

          {specialisations.length > 0 && (
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Specialisation
              </span>
              <select
                value={
                  typeof m.metadata?.specialisation === "string"
                    ? (m.metadata.specialisation as string)
                    : ""
                }
                onChange={(e) =>
                  update.mutate({
                    metadata: { ...m.metadata, specialisation: e.target.value || null },
                  })
                }
                className="input !w-auto !py-1 text-xs"
              >
                <option value="">— unspecialised —</option>
                {specialisations.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <dl className="grid grid-cols-2 gap-3 text-xs">
            <EditField label={fp.label("name", "Name")} value={m.name} onCommit={(v) => update.mutate({ name: v })} />
            {!fp.hidden("short_name") && <EditField label={fp.label("short_name", "Short name")} value={m.short_name ?? ""} onCommit={(v) => update.mutate({ short_name: v || null })} />}
            {!fp.hidden("family") && <EditField label={fp.label("family", "Family")} value={m.family ?? ""} onCommit={(v) => update.mutate({ family: v || null })} />}
            {!fp.hidden("type") && <EditField label={fp.label("type", "Type")} value={m.type ?? ""} onCommit={(v) => update.mutate({ type: v || null })} />}
            {!fp.hidden("manufacturer") && <EditField label={fp.label("manufacturer", "Manufacturer")} value={m.manufacturer ?? ""} onCommit={(v) => update.mutate({ manufacturer: v || null })} />}
            {!fp.hidden("state") && <EditField label={fp.label("state", "State")} value={m.state} onCommit={(v) => update.mutate({ state: v })} />}
            {!fp.hidden("quantity") && <EditField label={fp.label("quantity", "Quantity")} value={String(m.quantity)} numeric onCommit={(v) => update.mutate({ quantity: Number(v) || 0 })} />}
            <LocationPicker
              label="Location"
              value={m.location_id}
              onChange={(id) => update.mutate({ location_id: id })}
              size="sm"
            />
          </dl>

          <EntityAttachments kind={ENTITY_KIND} entityId={m.id} />

          <CustomFieldsPanel
            entityKind={ENTITY_KIND}
            entityId={m.id}
            values={m.metadata}
            onCommit={(name, value) =>
              update.mutate({
                metadata: { ...m.metadata, [name]: value },
              })
            }
          />

          <EditField
            label="Notes"
            value={m.notes ?? ""}
            multiline
            onCommit={(v) => update.mutate({ notes: v || null })}
          />

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

function NewMachineModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [family, setFamily] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setManufacturer("");
      setFamily("");
      setLocationId(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createMachine(activeSlug, {
        name: name.trim(),
        manufacturer: manufacturer.trim() || null,
        family: family.trim() || null,
        location_id: locationId,
      }),
    onSuccess: (m) => {
      toast.success("Machine added.");
      void qc.invalidateQueries({ queryKey: ["machines", activeSlug] });
      onClose();
      navigate(`/machines/${m.id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="new machine" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Name
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Manufacturer
          </span>
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
            Family (e.g. "Voron", "Railcore")
          </span>
          <input value={family} onChange={(e) => setFamily(e.target.value)} className="input" />
        </label>
        <LocationPicker
          label="Location"
          value={locationId}
          onChange={setLocationId}
        />
        <p className="text-[10px] text-faint">
          Want make/model fields — hotend, firmware, bed size, etc.? Add a
          specialization for your machine type from the{" "}
          <Link to="/bundles" className="text-accent hover:underline">
            marketplace
          </Link>{" "}
          (e.g. “3D Printers”) and they’ll show up here.
        </p>
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
