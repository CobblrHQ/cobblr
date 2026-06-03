// /assets — list + detail modal for the assets module. Same shape
// as MachinesPage. No specialisations yet (no assets:asset Pillar-E
// modules ship), so no lens UI here — but the column rendering is
// already lens-ready: when a future "Vintage Tools" or
// "Collectibles" module contributes field-defs, they'll appear as
// extra columns automatically (no code change here).

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Printer, Search, Tag as TagIcon, Trash2 } from "lucide-react";
import { ApiError, api, type Asset, type OrgModuleListItem, type PlatformFieldDef } from "../lib/api";
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

const ENTITY_KIND = "assets:asset";

export function AssetsPage() {
  usePageTitle("Assets");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const lensName = searchParams.get("lens");

  const list = useQuery({
    queryKey: ["assets", activeSlug],
    queryFn: () => api.listAssets(activeSlug),
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

  const lensFieldDefs: PlatformFieldDef[] = (fieldDefs.data?.items ?? []).filter((d) => {
    if (lensName) return d.source_module === lensName;
    return d.source_module !== null;
  });
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
        await api.deleteAsset(activeSlug, id);
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
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">
          assets
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
          <Plus size={14} /> New asset
        </button>
      </div>

      {viewMode === "tiles" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => navigate(`/assets/${a.id}${searchParams.toString() ? `?${searchParams}` : ""}`)}
              className="text-left"
            >
              <EntityTile
                src={a.image_path}
                title={a.name}
                subtitle={a.manufacturer || a.model || a.short_name || null}
                badge={a.state}
              />
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full px-3 py-10 text-center text-xs text-faint italic">
              {allRows.length === 0
                ? "No assets yet. Click + new to add one."
                : "No matches with the current filters."}
            </div>
          )}
        </div>
      )}

      {viewMode === "list" && (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(e) => selectAll(e.target.checked)}
                  className="accent-cobble-600"
                  aria-label="Select all"
                />
              </th>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Manufacturer</th>
              <th className="text-left px-3 py-2">Model</th>
              <th className="text-left px-3 py-2">State</th>
              {lensFieldDefs.map((d) => (
                <th key={d.id} className="text-left px-3 py-2">{d.display_label}</th>
              ))}
              <th className="text-right px-3 py-2">qty</th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line dark:divide-slate-700">
            {filtered.map((a) => (
              <tr
                key={a.id}
                onClick={() => navigate(`/assets/${a.id}${searchParams.toString() ? `?${searchParams}` : ""}`)}
                className="hover:bg-subtle dark:hover:bg-slate-800/40 transition cursor-pointer"
              >
                <td
                  className="px-3 py-2 w-8"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={(e) => toggleRow(a.id, e.target.checked)}
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
                {lensFieldDefs.map((d) => {
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
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6 + lensFieldDefs.length + 1} className="px-3 py-10 text-center text-xs text-faint italic">
                  {allRows.length === 0
                    ? "No assets yet. Click + new to add one."
                    : "No matches with the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      <AssetDetailModal
        assetId={id ?? null}
        onClose={() => navigate(`/assets${searchParams.toString() ? `?${searchParams}` : ""}`)}
      />
      <NewAssetModal open={newOpen} onClose={() => setNewOpen(false)} />
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
                  message: "This is permanent — the rows will be removed from the workspace.",
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

function AssetDetailModal({ assetId, onClose }: { assetId: string | null; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fp = useFieldPresentation(ENTITY_KIND);
  const asset = useQuery({
    queryKey: ["asset", activeSlug, assetId],
    queryFn: () => api.getAsset(activeSlug, assetId!),
    enabled: !!assetId,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<Asset>) => api.updateAsset(activeSlug, assetId!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["asset", activeSlug, assetId] });
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAsset(activeSlug, assetId!),
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

  return (
    <Modal open={!!assetId} onClose={onClose} title={a?.name ?? "loading…"} subtitle={a ? `${a.manufacturer ?? "—"} · ${a.state}` : undefined} size="lg">
      {a ? (
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <EntityThumb
              src={a.image_path}
              alt={a.name}
              size={128}
              className="ring-1 ring-line dark:ring-slate-700"
            />
            <div className="flex-1">
              <EntityActionsBar entityKind={ENTITY_KIND} entityId={a.id} />
            </div>
          </div>
          {/* Native fields, reshaped by the workspace's field-presentation
              overrides — a bundle/config can relabel (e.g. Manufacturer → Make)
              or hide the ones a focused use-case doesn't need. `name` is the
              identity, so it's relabel-only (never hidden). */}
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <EditField label={fp.label("name", "Name")} value={a.name} onCommit={(v) => update.mutate({ name: v })} />
            {!fp.hidden("short_name") && <EditField label={fp.label("short_name", "Short name")} value={a.short_name ?? ""} onCommit={(v) => update.mutate({ short_name: v || null })} />}
            {!fp.hidden("manufacturer") && <EditField label={fp.label("manufacturer", "Manufacturer")} value={a.manufacturer ?? ""} onCommit={(v) => update.mutate({ manufacturer: v || null })} />}
            {!fp.hidden("model") && <EditField label={fp.label("model", "Model")} value={a.model ?? ""} onCommit={(v) => update.mutate({ model: v || null })} />}
            {!fp.hidden("type") && <EditField label={fp.label("type", "Type")} value={a.type ?? ""} onCommit={(v) => update.mutate({ type: v || null })} />}
            {!fp.hidden("state") && <EditField label={fp.label("state", "State")} value={a.state} onCommit={(v) => update.mutate({ state: v })} />}
            {!fp.hidden("serial_number") && <EditField label={fp.label("serial_number", "Serial number")} value={a.serial_number ?? ""} onCommit={(v) => update.mutate({ serial_number: v || null })} />}
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
            entityKind={ENTITY_KIND}
            entityId={a.id}
            values={a.metadata}
            onCommit={(name, value) =>
              update.mutate({ metadata: { ...a.metadata, [name]: value } })
            }
          />
          <EntityAttachments kind={ENTITY_KIND} entityId={a.id} />
          <EditField label="Notes" value={a.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />
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
      ) : (
        <div className="text-xs text-faint">loading…</div>
      )}
    </Modal>
  );
}

function NewAssetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
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
      }),
    onSuccess: (a) => {
      toast.success("Asset added.");
      void qc.invalidateQueries({ queryKey: ["assets", activeSlug] });
      onClose();
      navigate(`/assets/${a.id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title="new asset" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
        </label>
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Manufacturer</span>
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
