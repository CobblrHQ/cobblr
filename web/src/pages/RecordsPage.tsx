// /records — list + detail modal for the records module, the neutral
// generic-record substrate. Same shape as AssetsPage minus the domain
// columns: a record carries ONLY the universal base (name, image, notes,
// location, custom-field bag), so the interesting columns all come from
// each collection's declared field-defs.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Album, ChevronRight, Image as ImageIcon, Plus, Search, Trash2 } from "lucide-react";
import { ApiError, api, type RecordItem, type PlatformFieldDef } from "../lib/api";
import { ModuleInstanceChooser } from "../components/ModuleInstanceChooser";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import {
  CustomFieldsPanel,
  EntityActionsBar,
  EntityThumb,
  EntityTile,
  Modal,
  ViewModeToggle,
  useConfirm,
  usePageTitle,
  useToast,
  useViewMode,
} from "@cobblr/platform-web";
import { EntityAttachments } from "../components/EntityAttachments";
import { EntityImageEdit } from "../components/EntityImageEdit";
import { ImageSearchPicker } from "../components/ImageSearchPicker";
import { LocationTreePicker } from "../components/LocationTreePicker";

const ENTITY_KIND = "records:record";

export function RecordsPage({
  instance,
  displayName,
  itemNoun,
}: { instance?: string; displayName?: string; itemNoun?: string } = {}) {
  // When `instance` is set we render ONE named collection of records (e.g.
  // "Bookshelf"), reached at the clean /<instance> URL — the SAME page as
  // /records (thumbnails, views, detail/edit), just scoped to the instance's
  // items. Detail is local state (no /<instance>/:id route). Mirrors AssetsPage.
  usePageTitle(displayName ?? "Records");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const noun = itemNoun?.trim() || "record";
  // On an instance page, fields/views are keyed to the instance
  // ("bookshelf:item") rather than the base records:record.
  const entityKind = instance ? `${instance}:item` : ENTITY_KIND;

  // Detail selection: URL param on /records, local state (+ deep-link
  // ?record=id) on an instance page.
  const [localSel, setLocalSel] = useState<string | null>(null);
  const selectedId = instance ? localSel : id ?? null;
  useEffect(() => {
    if (!instance) return;
    const r = searchParams.get("record");
    if (r && r !== localSel) setLocalSel(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, searchParams]);
  const openDetail = (rid: string) => {
    if (instance) {
      setLocalSel(rid);
      setSearchParams((prev) => { prev.set("record", rid); return prev; }, { replace: true });
    } else navigate(`/records/${rid}${searchParams.toString() ? `?${searchParams}` : ""}`);
  };
  const closeDetail = () => {
    if (instance) {
      setLocalSel(null);
      setSearchParams((prev) => { prev.delete("record"); return prev; }, { replace: true });
    } else navigate(`/records${searchParams.toString() ? `?${searchParams}` : ""}`);
  };

  const list = useQuery({
    queryKey: ["records", activeSlug, instance ?? null],
    queryFn: () => api.listRecords(activeSlug, instance),
    enabled: !!activeSlug,
  });
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", activeSlug, entityKind, "effective"],
    queryFn: () => api.listFieldDefs(activeSlug, entityKind, true),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  // Records instances (Bookshelf / Movies / …). With no base-table records,
  // show these as a chooser instead of a bare "nothing here".
  const recordInstances = useQuery({
    queryKey: ["instances", activeSlug, "records"],
    queryFn: () => api.listInstances(activeSlug, "records"),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });

  // The substrate has no domain columns, so EVERY declared/custom field is a
  // candidate list column.
  const customCols: PlatformFieldDef[] = fieldDefs.data?.items ?? [];

  const allRows = list.data?.items ?? [];
  const [query, setQuery] = useState("");
  const filtered = query
    ? allRows.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()))
    : allRows;

  const [newOpen, setNewOpen] = useState(false);
  const [viewMode, setViewMode] = useViewMode("records", "list");
  const openRecord = (rid: string) => openDetail(rid);

  // Fill the gaps in one press instead of opening each record and clicking
  // Auto. Only offered when there ARE gaps, so an established collection isn't
  // carrying a button with nothing to do.
  const qc = useQueryClient();
  const toast = useToast();
  const missingCovers = allRows.filter((r) => !(r.image_path ?? "").trim()).length;
  const backfill = useMutation({
    mutationFn: () =>
      api.backfillEntityImages(activeSlug, { entity_kind: entityKind, instance, limit: 25 }),
    onSuccess: (r) => {
      if (r.started === 0) {
        // Say WHICH kind of nothing. Blaming the data for a wiring gap sent a
        // real debugging session down the wrong path (reported 2026-07-18).
        if (r.unresolved > 0)
          toast.error(
            `Couldn't read ${r.unresolved} ${noun}${r.unresolved === 1 ? "" : "s"} — that's a bug on our side, not your data.`,
          );
        else if (r.unnamed > 0)
          toast.error(`Nothing to look up — these ${noun}s need a name first.`);
        else toast.success(`Every ${noun} already has an image.`);
        return;
      }
      toast.success(
        `Looking up ${r.started} image${r.started === 1 ? "" : "s"}…` +
          (r.remaining > 0 ? ` ${r.remaining} more after this, press again.` : ""),
      );
      // They land one at a time (a search + download each); refresh as they arrive.
      for (const ms of [4000, 10000, 20000]) {
        setTimeout(() => void qc.invalidateQueries({ queryKey: ["records", activeSlug] }), ms);
      }
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the lookup."),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          {displayName ?? "records"}
        </h1>
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
        {missingCovers > 0 && (
          <button
            onClick={() => backfill.mutate()}
            disabled={backfill.isPending}
            title={`Look up an image for the ${missingCovers} ${noun}${missingCovers === 1 ? "" : "s"} without one`}
            className="rounded-md border border-line dark:border-slate-600 hover:border-faint disabled:opacity-50 text-muted hover:text-content text-xs font-medium px-3 py-2 transition flex items-center gap-1.5"
          >
            <ImageIcon size={13} />
            {backfill.isPending ? "starting…" : `fetch ${missingCovers} missing image${missingCovers === 1 ? "" : "s"}`}
          </button>
        )}
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <button
          onClick={() => setNewOpen(true)}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition flex items-center gap-1.5"
        >
          <Plus size={14} /> New {noun}
        </button>
      </div>

      {filtered.length === 0 ? (
        // The instance-chooser is a BASE-page affordance ("pick one of your
        // collections"); on an instance page we're already inside one.
        !instance && allRows.length === 0 && (recordInstances.data?.items.length ?? 0) > 0 ? (
          <ModuleInstanceChooser instances={recordInstances.data!.items} icon={Album} noun="record" />
        ) : (
          <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-12 text-center text-xs text-faint dark:text-slate-500 italic">
            {allRows.length === 0
              ? `No ${noun}s yet. Click + New ${noun} to add one.`
              : "No matches with the current filters."}
          </div>
        )
      ) : viewMode === "tiles" ? (
        <RecordsTiles rows={filtered} onOpen={openRecord} />
      ) : (
        <RecordsTable rows={filtered} customCols={customCols} onOpen={openRecord} />
      )}

      <RecordDetailModal recordId={selectedId} onClose={closeDetail} instance={instance} noun={noun} />
      <NewRecordModal open={newOpen} onClose={() => setNewOpen(false)} instance={instance} noun={noun} />
    </div>
  );
}

function RecordsTiles({ rows, onOpen }: { rows: RecordItem[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {rows.map((r) => (
        <button key={r.id} type="button" onClick={() => onOpen(r.id)} className="text-left">
          <EntityTile src={r.image_path} title={r.name} subtitle={null} />
        </button>
      ))}
    </div>
  );
}

function RecordsTable({
  rows,
  customCols,
  onOpen,
}: {
  rows: RecordItem[];
  customCols: PlatformFieldDef[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-subtle/60 dark:bg-slate-800/40 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
          <tr>
            <th className="text-left px-3 py-2">Name</th>
            {customCols.map((d) => (
              <th key={d.id} className="text-left px-3 py-2">{d.display_label}</th>
            ))}
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line dark:divide-slate-700">
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onOpen(r.id)}
              className="hover:bg-subtle dark:hover:bg-slate-800/40 transition cursor-pointer"
            >
              <td className="px-3 py-2 text-content dark:text-mortar-100 font-medium">
                <div className="flex items-center gap-3">
                  <EntityThumb src={r.image_path} alt={r.name} size={56} />
                  <span className="truncate">{r.name}</span>
                </div>
              </td>
              {customCols.map((d) => {
                const v = (r.metadata as Record<string, unknown>)[d.name];
                return (
                  <td key={d.id} className="px-3 py-2 text-content dark:text-mortar-200 text-xs">
                    {v === null || v === undefined || v === "" ? "—" : String(v)}
                  </td>
                );
              })}
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

function RecordDetailModal({
  recordId,
  onClose,
  instance,
  noun,
}: { recordId: string | null; onClose: () => void; instance?: string; noun: string }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  // On an instance page the item lives under /instances/<name>/items and its
  // custom fields are keyed to the instance ("bookshelf:item"), NOT the base
  // records:record — reading/writing without the instance 404s. Thread it
  // through every record call + the field kind. Mirrors AssetDetailModal.
  const kind = instance ? `${instance}:item` : ENTITY_KIND;
  const fp = useFieldPresentation(kind);
  const record = useQuery({
    queryKey: ["record", activeSlug, instance ?? null, recordId],
    queryFn: () => api.getRecord(activeSlug, recordId!, instance),
    enabled: !!recordId,
    // A server error (404/403/…) is deterministic — don't retry it 3× with
    // backoff before showing the error state; only retry transient network fails.
    retry: (n, e) => !(e instanceof ApiError) && n < 2,
  });
  const update = useMutation({
    mutationFn: (patch: Partial<RecordItem>) => api.updateRecord(activeSlug, recordId!, patch, instance),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["record", activeSlug, instance ?? null, recordId] });
      void qc.invalidateQueries({ queryKey: ["records", activeSlug] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRecord(activeSlug, recordId!, instance),
    onSuccess: () => {
      toast.success(`${noun[0]!.toUpperCase()}${noun.slice(1)} deleted.`);
      void qc.invalidateQueries({ queryKey: ["records", activeSlug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't delete."),
  });

  const r = record.data;
  // A record with no cover had NO way to get one: the detail rendered a
  // read-only thumb, unlike assets/machines which ship the image editor +
  // web search. Three books arrived coverless from the scan inbox and were
  // stuck that way (reported 2026-07-18). Same two paths those pages use:
  // "Auto" searches by the record's own identity, and the picker lets you
  // choose a specific result.
  const [autoBusy, setAutoBusy] = useState(false);
  // No query is built here ON PURPOSE: omitting it makes the server derive the
  // phrase from this record's own name + fields, the same derivation the
  // picker and the scan inbox use. A locally-built phrase is how the surfaces
  // drifted apart in the first place.
  function refetchRecord() {
    void qc.invalidateQueries({ queryKey: ["record", activeSlug, instance ?? null, recordId] });
    void qc.invalidateQueries({ queryKey: ["records", activeSlug] });
  }
  async function runAutoFetch() {
    if (!r) return;
    setAutoBusy(true);
    try {
      const res = await api
        .enrichEntityImage(activeSlug, { entity_kind: kind, entity_id: r.id, instance })
        .catch(() => null);
      if (res?.image_path) refetchRecord();
      else toast.error("Couldn't find an image to auto-fetch.");
    } finally {
      setAutoBusy(false);
    }
  }
  const [photoSearchOpen, setPhotoSearchOpen] = useState(false);
  const [photoPickBusy, setPhotoPickBusy] = useState(false);
  async function pickWebPhoto(url: string) {
    if (!r) return;
    setPhotoPickBusy(true);
    try {
      const res = await api
        .enrichEntityImage(activeSlug, {
          entity_kind: kind,
          entity_id: r.id,
          instance,
          image_url: url, // a picked url skips the search entirely
        })
        .catch(() => null);
      if (res?.image_path) {
        refetchRecord();
        setPhotoSearchOpen(false);
      } else toast.error("Couldn't save that image.");
    } finally {
      setPhotoPickBusy(false);
    }
  }

  async function handleDelete() {
    if (!r) return;
    const ok = await confirm({
      title: `Delete "${r.name}"?`,
      message: "This can't be undone.",
      confirmLabel: `Delete ${noun}`,
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  return (
    <Modal open={!!recordId} onClose={onClose} title={r?.name ?? (record.isError ? "Couldn't load" : "loading…")} size="xl">
      {r ? (
        <div className="space-y-4">
          {/* Wide record layout: the cover large on the LEFT, fields on the
              RIGHT — so an image-bearing record (a book, a film, a bottle)
              uses the width instead of scrolling tall. Stacks on phones. */}
          <div className="grid gap-6 md:grid-cols-[minmax(200px,260px)_1fr]">
            <div className="space-y-3">
              {/* The cover keeps its OWN proportions. A square thumb
                  object-cover-cropped a portrait book jacket top and bottom
                  while the column had height to spare (reported 2026-07-18) — a
                  record's image is usually the identity (a jacket, a poster,
                  a label), so it renders whole, not cropped to a tile. */}
              <EntityImageEdit
                slug={activeSlug}
                src={r.image_path}
                alt={r.name}
                size={256}
                fit="contain"
                onChange={(image_path) => update.mutate({ image_path })}
                onAutoFetch={runAutoFetch}
                autoBusy={autoBusy}
              />
              <div>
                <button
                  type="button"
                  onClick={() => setPhotoSearchOpen((v) => !v)}
                  className="text-[10px] font-mono uppercase tracking-widest text-accent hover:underline"
                >
                  {photoSearchOpen ? "hide image search" : "search the web for an image"}
                </button>
                {photoSearchOpen && (
                  <div className="mt-1.5">
                    {/* Derived mode: the server builds the phrase from this
                        record's own name + fields, identically to the scan
                        inbox. No hand-built query here on purpose. */}
                    <ImageSearchPicker
                      entity={{ kind: kind, id: r.id }}
                      busy={photoPickBusy}
                      onPick={pickWebPhoto}
                      label="pick an image"
                    />
                  </div>
                )}
              </div>
              <EntityActionsBar entityKind={ENTITY_KIND} entityId={r.id} />
            </div>
            <div className="min-w-0 space-y-4">
              {/* Native fields are just the universal base; everything
                  domain-shaped lives in the CustomFieldsPanel below. */}
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <EditField label={fp.label("name", "Name")} value={r.name} onCommit={(v) => update.mutate({ name: v })} />
                <LocationTreePicker
                  label="Location"
                  value={r.location_id}
                  onChange={(lid) => update.mutate({ location_id: lid })}
                  size="sm"
                />
              </dl>
              <CustomFieldsPanel
                entityKind={kind}
                entityId={r.id}
                values={r.metadata}
                onCommit={(name, value) =>
                  update.mutate({ metadata: { ...r.metadata, [name]: value } })
                }
              />
              <EntityAttachments kind={ENTITY_KIND} entityId={r.id} />
              <EditField label={fp.label("notes", "Notes")} value={r.notes ?? ""} multiline onCommit={(v) => update.mutate({ notes: v || null })} />
            </div>
          </div>
          <div className="pt-3 border-t border-line dark:border-slate-700 flex items-center justify-between">
            <button
              onClick={handleDelete}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> delete {noun}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      ) : record.isError ? (
        // Don't sit on "loading…" forever when the fetch fails — say what
        // went wrong + offer a retry, so it's never a silent mystery.
        <div className="space-y-2 py-2 text-sm">
          <div className="text-ember-600 dark:text-ember-400">
            Couldn't load this {noun}
            {record.error instanceof ApiError ? `: ${record.error.message}` : "."}
          </div>
          <button
            type="button"
            onClick={() => void record.refetch()}
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

function NewRecordModal({
  open,
  onClose,
  instance,
  noun = "record",
}: { open: boolean; onClose: () => void; instance?: string; noun?: string }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setLocationId(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createRecord(activeSlug, {
        name: name.trim(),
        location_id: locationId,
      }, instance),
    onSuccess: (r) => {
      toast.success(`${noun[0]!.toUpperCase()}${noun.slice(1)} added.`);
      void qc.invalidateQueries({ queryKey: ["records", activeSlug] });
      onClose();
      // On an instance page stay in the instance and deep-link the new
      // record's detail; on the base page go to /records/:id.
      navigate(instance ? `/${instance}?record=${r.id}` : `/records/${r.id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't create."),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title={`New ${noun}`} size="sm">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
        </label>
        <LocationTreePicker
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
  multiline,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
}) {
  const Cmp = multiline ? "textarea" : "input";
  return (
    <label className={"block " + (multiline ? "col-span-2" : "")}>
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      <Cmp
        type={multiline ? undefined : "text"}
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
