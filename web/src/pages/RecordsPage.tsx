import { useCloseToOrigin, useNewRecordBarcode, RecordFormModal, PresentationGate, useFaces } from "@cobblr/platform-web";
// /records — list + detail modal for the records module, the neutral
// generic-record substrate. Same shape as AssetsPage minus the domain
// columns: a record carries ONLY the universal base (name, image, notes,
// location, custom-field bag), so the interesting columns all come from
// each collection's declared field-defs.

import { countOf, itemNounFor, pluralise } from "@cobblr/platform-contract/plural";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Album, ChevronRight, Image as ImageIcon, Plus, Trash2 } from "lucide-react";
import { ApiError, api, type RecordItem, type PlatformFieldDef } from "../lib/api";
import { ModuleInstanceChooser } from "../components/ModuleInstanceChooser";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import {
  useLater,
  CustomFieldsPanel,
  EntityActionsBar,
  EntityThumb,
  EntityTile,
  FieldPack,
  ViewModeToggle,
  editFieldItem,
  fieldNeed,
  useConfirm,
  useCreateDoor,
  usePageTitle,
  usePageWidth,
  useToast,
  useViewMode, TILE_GRID, InboxWaitingStrip, SearchInput, CollectionHeader, headerButton } from "@cobblr/platform-web";
import { EntityAttachments } from "../components/EntityAttachments";
import { ContributedDetailPanels } from "../panels/registry";
import { RecordPhoto } from "../components/RecordPhoto";
import { pictureStateFor, suggestedSrcFor, usePhotoSuggestions } from "../lib/photoSuggestions";
import { LocationTreePicker } from "../components/LocationTreePicker";
import { resolveDetailPath } from "@cobblr/platform-contract/instance-detail";

const ENTITY_KIND = "records:record";

export function RecordsPage({
  instance,
  displayName,
  itemNoun,
  itemNounPlural,
  hint,
}: { instance?: string; displayName?: string; itemNoun?: string; itemNounPlural?: string; hint?: string | null } = {}) {
  const later = useLater();
  // When `instance` is set we render ONE named collection of records (e.g.
  // "Bookshelf"), reached at the clean /<instance> URL — the SAME page as
  // /records (thumbnails, views, detail/edit), just scoped to the instance's
  // items. Detail is local state (no /<instance>/:id route). Mirrors AssetsPage.
  // A wide table is the page here, so it gets the screen.
  usePageWidth("wide");
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // On an instance page, fields/views are keyed to the instance
  // ("bookshelf:item") rather than the base records:record.
  const entityKind = instance ? `${instance}:item` : ENTITY_KIND;
  // "record" is this MODULE's internal word, and falling back to it put "New
  // record" under a shelf of books (reported 2026-09-03). itemNounFor asks the
  // sources that actually know - the noun somebody set, then the entity kind -
  // and lands on the neutral "item" rather than a word from the plumbing. It
  // deliberately never guesses from the collection's own name: a Bookshelf
  // holds books, not bookshelves. Set the real word in instance settings.
  const noun = itemNounFor({ itemNoun, entityKind });
  const nounPlural = itemNounPlural?.trim() || pluralise(noun);
  const words = { singular: noun, plural: nounPlural };
  const heading = displayName ?? nounPlural.charAt(0).toUpperCase() + nounPlural.slice(1);
  usePageTitle(heading);

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
    } else {
      // RECORD-LINK-OK: the module's own page opening its own default-collection record in place; its base route is this page.
      navigate(`/records/${rid}${searchParams.toString() ? `?${searchParams}` : ""}`);
    }
  };
  // A record opened from somewhere else (a floor plan, a search) closes back
  // there; one opened by its link closes to the list (#6266).
  const closeToList = useCloseToOrigin(`/records${searchParams.toString() ? `?${searchParams}` : ""}`);
  const closeDetail = () => {
    if (instance) {
      setLocalSel(null);
      setSearchParams((prev) => { prev.delete("record"); return prev; }, { replace: true });
    } else closeToList();
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
  // `?new=1` (a view's empty state, a card) opens the form on arrival.
  const closeCreateDoor = useCreateDoor(useCallback(() => setNewOpen(true), []));
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
            `Couldn't read ${countOf(r.unresolved, words)}. That's a bug on our side, not your data.`,
          );
        else if (r.unnamed > 0)
          toast.error(`Nothing to look up: these ${nounPlural} need a name first.`);
        else toast.success(`Every ${noun} already has an image.`);
        return;
      }
      toast.success(
        `Looking up ${r.started} image${r.started === 1 ? "" : "s"}…` +
          (r.remaining > 0 ? ` ${r.remaining} more after this, press again.` : ""),
      );
      // They land one at a time (a search + download each); refresh as they arrive.
      for (const ms of [4000, 10000, 20000]) {
        later.after(`refresh-${ms}`, ms, () => void qc.invalidateQueries({ queryKey: ["records", activeSlug] }));
      }
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the lookup."),
  });

  return (
    <div className="space-y-4">
      <CollectionHeader
        title={heading}
        count={`${filtered.length} of ${list.data?.total ?? allRows.length}`}
        hint={hint} kind={instance ? `${instance}:item` : ENTITY_KIND}
        search={<SearchInput value={query} onChange={setQuery} placeholder="search…" aria-label={`Search ${nounPlural}`} wrapperClassName="w-48 max-sm:w-full max-sm:flex-1" />}
        exportQuery={query}
        actions={
          <>
            {missingCovers > 0 && (
              <button
                onClick={() => backfill.mutate()}
                disabled={backfill.isPending}
                title={`Look up an image for the ${countOf(missingCovers, words)} without one`}
                className={`${headerButton("secondary")} text-xs text-muted hover:text-content disabled:opacity-50`}
              >
                <ImageIcon size={13} />
                {backfill.isPending ? "starting…" : `fetch ${missingCovers} missing image${missingCovers === 1 ? "" : "s"}`}
              </button>
            )}
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
            <button onClick={() => setNewOpen(true)} className={headerButton("primary")}>
              <Plus size={14} /> New {noun}
            </button>
          </>
        }
      />

      {filtered.length === 0 ? (
        // The instance-chooser is a BASE-page affordance ("pick one of your
        // collections"); on an instance page we're already inside one.
        !instance && allRows.length === 0 && (recordInstances.data?.items.length ?? 0) > 0 ? (
          <ModuleInstanceChooser instances={recordInstances.data!.items} icon={Album} noun="record" />
        ) : (
          <div className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-12 text-center text-xs text-faint dark:text-slate-500 italic">
            {allRows.length === 0
              ? `No ${nounPlural} yet. Add one with New ${noun}.`
              : "No matches with the current filters."}
          </div>
        )
      ) : viewMode === "tiles" ? (
        <RecordsTiles rows={filtered} onOpen={openRecord} kind={instance ? `${instance}:item` : ENTITY_KIND} />
      ) : (
        <RecordsTable rows={filtered} customCols={customCols} onOpen={openRecord} kind={instance ? `${instance}:item` : ENTITY_KIND} />
      )}
      {/* What is waiting in the scan inbox to come here, under the filed
          results: a thing just scanned is in no table until it is filed. */}
      <InboxWaitingStrip destination={instance ?? "records"} q={query} />

      <RecordDetailModal recordId={selectedId} onClose={closeDetail} instance={instance} noun={noun} />
      <NewRecordModal
        open={newOpen}
        onClose={() => {
          setNewOpen(false);
          closeCreateDoor();
        }}
        instance={instance}
        noun={noun}
      />
    </div>
  );
}

function RecordsTiles({ rows, onOpen, kind }: { rows: RecordItem[]; onOpen: (id: string) => void; kind: string }) {
  const suggestions = usePhotoSuggestions(kind, rows.map((r) => r.id));
  return (
    <div className={TILE_GRID}>
      {rows.map((r) => (
        <button key={r.id} type="button" onClick={() => onOpen(r.id)} className="text-left">
          <EntityTile src={r.image_path} suggestedSrc={suggestedSrcFor(suggestions, r.id, r.image_path)} pictureState={pictureStateFor(suggestions, r.id, r.image_path)} title={r.name} subtitle={null} />
        </button>
      ))}
    </div>
  );
}

function RecordsTable({
  rows,
  customCols,
  onOpen,
  kind,
}: {
  rows: RecordItem[];
  customCols: PlatformFieldDef[];
  onOpen: (id: string) => void;
  kind: string;
}) {
  const suggestions = usePhotoSuggestions(kind, rows.map((r) => r.id));
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
                  <EntityThumb src={r.image_path} suggestedSrc={suggestedSrcFor(suggestions, r.id, r.image_path)} pictureState={pictureStateFor(suggestions, r.id, r.image_path)} alt={r.name} size={56} />
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

export function RecordDetailModal({
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
  // The collection's faces decide sections and verbs; the body waits for them.
  const shape = useFaces(kind);
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
    onError: (e: unknown) => toast.error(`Couldn't save that change: ${e instanceof ApiError ? e.message : String(e)}`),
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
      else toast.error(res?.reason ?? "No photo found that clearly shows this.");
    } finally {
      setAutoBusy(false);
    }
  }
  async function handleDelete() {
    if (!r) return;
    const ok = await confirm({
      title: `Delete "${r.name}"?`,
      message: `You can restore this ${noun} from Recently deleted for 30 days.`,
      confirmLabel: `Delete ${noun}`,
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  return (
    <RecordFormModal open={!!recordId} onClose={onClose} title={r?.name ?? (record.isError ? "Couldn't load" : "loading…")}>
      {r ? (
        <PresentationGate ready={fp.ready && shape.ready} failed={fp.failed || shape.failed} retry={() => { fp.retry(); shape.retry(); }}>
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
              <RecordPhoto
                kind={kind}
                id={r.id}
                instance={instance}
                src={r.image_path}
                alt={r.name}
                size={256}
                fit="contain"
                onChange={(image_path) => update.mutate({ image_path })}
                onAutoFetch={runAutoFetch}
                autoBusy={autoBusy}
                onSaved={() => {
                  refetchRecord();
                  void qc.invalidateQueries({ queryKey: ["records", activeSlug] });
                }}
              />
              <EntityActionsBar entityKind={ENTITY_KIND} entityId={r.id} />
            </div>
            <div className="min-w-0 space-y-4">
              {/* Native fields are just the universal base; everything
                  domain-shaped lives in the CustomFieldsPanel below. The
                  packer lays them out from what each needs (#3067). */}
              <FieldPack
                className="text-xs"
                items={[
                  editFieldItem("name", { label: fp.label("name", "Name"), value: r.name, onCommit: (v) => update.mutate({ name: v }) }),
                  {
                    need: fieldNeed("location", { control: "picker", label: "Location" }),
                    node: <LocationTreePicker label="Location" value={r.location_id} onChange={(lid) => update.mutate({ location_id: lid })} size="sm" thing={{ kind: "records:record", id: r.id }} onPlaced={() => { void qc.invalidateQueries({ queryKey: ["record", activeSlug, instance ?? null, recordId] }); void qc.invalidateQueries({ queryKey: ["records", activeSlug] }); }} />,
                  },
                ]}
              />
              <CustomFieldsPanel
                entityKind={kind}
                entityId={r.id}
                values={r.metadata}
                onCommit={(name, value) =>
                  update.mutate({ metadata: { [name]: value } })
                }
              />
              <ContributedDetailPanels
                target={ENTITY_KIND}
                ctx={{ slug: activeSlug, entityId: r.id, entityTitle: r.name, hints: { collection: instance ? `${instance}:item` : undefined } }}
              />
              <EntityAttachments kind={ENTITY_KIND} entityId={r.id} collection={instance ? `${instance}:item` : undefined} omit={["tags", "discussion", "pairings"]} />
              <FieldPack className="text-xs" items={[editFieldItem("notes", { label: fp.label("notes", "Notes"), value: r.notes ?? "", multiline: true, onCommit: (v) => update.mutate({ notes: v || null }) })]} />
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
        </PresentationGate>
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
    </RecordFormModal>
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

  const [barcodeMetadata, setBarcodeMetadata] = useState<Record<string, unknown>>({});
  const [barcodeImage, setBarcodeImage] = useState("");
  const barcode = useNewRecordBarcode({ kind: instance ? `${instance}:item` : "records:record", metadata: barcodeMetadata, setMetadata: setBarcodeMetadata, natives: [
    { name: "name", label: "Name", key: "title", value: name, setValue: setName },
    { name: "image_path", label: "Photo", key: "image_url", value: barcodeImage, setValue: setBarcodeImage },
  ] });
  useEffect(() => { if (open) { setBarcodeMetadata({}); setBarcodeImage(""); } }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createRecord(activeSlug, {
        name: name.trim(),
        metadata: barcodeMetadata,
        image_path: barcodeImage || null,
        location_id: locationId,
      }, instance),
    onSuccess: (r) => {
      toast.success(`${noun[0]!.toUpperCase()}${noun.slice(1)} added.`);
      void qc.invalidateQueries({ queryKey: ["records", activeSlug] });
      onClose();
      // On an instance page stay in the instance and deep-link the new
      // record's detail; on the base page go to /records/:id.
      navigate(resolveDetailPath({ kind: "records:record", id: r.id, instance: instance ?? null, detailUrl: null, baseDetailRoute: "/records/{id}" }) ?? "/records");
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
        <FieldPack items={[
          {
            need: fieldNeed("name", { control: "text", label: "Name" }),
            node: (
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="input" />
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

