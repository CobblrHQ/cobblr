// /locations/:id — full-entity detail view.
//
// Locations are now first-class entities (Punch-list #1 from
// docs/product/homebox-parity-report.md): notes, description, photos,
// tags, and a "what's in here" rollup that sweeps every module
// with location-bearing entities.

import { useMemo, useState } from "react";
import { useKindLabels } from "../lib/useKindLabels";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { QuickCreateLocation } from "../components/QuickCreateLocation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRightLeft, ChevronRight, MapPin, Plus, Save, Trash2 } from "lucide-react";
import { MoveEverythingModal, movedSentence, putBackSentence } from "../components/MoveEverythingModal";

import { CustomFieldsPanel, EntityActionsBar, EntityThumb, FieldPack, LabeledField, Modal, fieldNeed, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type Location, type PlatformEntityKind } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { EntityAttachments } from "../components/EntityAttachments";
import { ContributedDetailPanels } from "../panels/registry";
import { FloorPlan } from "../components/FloorPlan";
import { LocationTreePicker } from "../components/LocationTreePicker";
import { DuplicatePlaceNotice, duplicatePlaceOf } from "../components/DuplicatePlaceNotice";
import { hasOwnLayout, readRect } from "../lib/floorplanGeometry";
import { pinnedFirst } from "../lib/placeItems";
import { recordHref } from "@cobblr/platform-contract/instance-detail";
import { countOf } from "@cobblr/platform-contract/plural";
import { deleteDialogMessage, deletedSentence, restoredSentence } from "../lib/placeDelete";

/** Where a kind's detail page lives. The placement endpoint answers WHAT is
 *  here; the registry is still how a kind says where to click through to. */
function detailRoutes(kinds: PlatformEntityKind[]): Map<string, string> {
  // The registry's template is "{id}", not ":id" — the same substitution
  // useDetailRoute and SearchBar do.
  return new Map(kinds.filter((k) => k.detail_route).map((k) => [k.id, k.detail_route!]));
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function LocationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingChild, setAddingChild] = useState(false);

  const location = useQuery({
    queryKey: ["location", activeSlug, id],
    queryFn: () => api.getLocation(activeSlug, id!),
    enabled: !!activeSlug && !!id,
  });
  usePageTitle(location.data?.name ?? "Location");
  // Single-SKU bin? Offer the direct qty-adjust card (the "bin of M3 screws"
  // flow — same card the scanner pops on the bin's QR).
  const binContents = useQuery({
    queryKey: ["bin-contents", activeSlug, id],
    queryFn: () => api.binContents(activeSlug, id!),
    enabled: !!activeSlug && !!id,
    staleTime: 30_000,
  });

  const allLocations = useQuery({
    queryKey: ["locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });

  // Children of this location.
  const children = useMemo(() => {
    return (allLocations.data?.items ?? []).filter((l) => l.parent_id === id);
  }, [allLocations.data, id]);

  // Every kind this workspace has that can carry a location, from the registry.
  const kinds = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  const routes = useMemo(() => detailRoutes(kinds.data?.items ?? []), [kinds.data]);

  // Contents — everything stored here, whatever kind it is.
  //
  // ONE question, asked of the primitive that owns the answer. This used to
  // walk the entity registry and probe each location-bearing kind's own list
  // endpoint with `?location_id=`, which is a filter most of them do not
  // implement: they ignored the query string and returned their whole table,
  // so every room showed the same items and a book shelved in the dining room
  // turned up in the den (reported 2026-08-23). Re-checking each row's
  // `location_id` client-side does not rescue it either — a record's location
  // lives in the placement table and its `location_id` column reads null, so
  // the check that fixed the over-listing would have emptied the section.
  //
  // Placement IS where "what is this inside of" is kept
  // (docs/design-decisions/placement-and-containment.md), mirrored from every
  // location-bearing table by DB trigger, so one call answers for all kinds at
  // once — instance kinds and any module added later included. There is now
  // one implementation of this question instead of two that disagreed.
  const contents = useQuery({
    queryKey: ["location-contents", activeSlug, id],
    queryFn: () =>
      api.placementContents(activeSlug, "core-locations:location", id!),
    enabled: !!activeSlug && !!id,
  });

  // A field a bundle or a person adds to places, saved on its own and merged
  // into the place's metadata server-side (the floor-plan keys beside it stay).
  const setField = useMutation({
    mutationFn: (metadata: Record<string, unknown>) => api.updateLocation(activeSlug, id!, { metadata }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["location", activeSlug, id] });
      void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
    },
    onError: (e: unknown) => toast.error(`Couldn't save that change: ${e instanceof ApiError ? e.message : String(e)}`),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteLocation(activeSlug, id!),
    onSuccess: (gone) => {
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
      };
      refresh();
      toast.action(deletedSentence(gone.name, gone), {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            const back = await api.restoreDeletedLocation(activeSlug, id!);
            refresh();
            toast.success(restoredSentence(back));
            navigate(`/locations/${id}`);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
      navigate("/locations");
    },
    // A refusal that can be asked for opens the blocked-action sheet by
    // itself (api.ts); a toast on top would say the same thing twice.
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.blocked) return;
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });

  if (!id) return <Navigate to="/locations" replace />;
  if (location.isLoading) return <div className="text-sm text-faint">loading…</div>;
  if (location.error)
    return <div className="text-sm text-ember-500">{(location.error as Error).message}</div>;
  if (!location.data) return null;
  const l = location.data;

  const breadcrumbs = (() => {
    const out: Location[] = [];
    let cursor: string | null = l.parent_id;
    const byId = new Map((allLocations.data?.items ?? []).map((x) => [x.id, x]));
    while (cursor) {
      const p = byId.get(cursor);
      if (!p) break;
      out.unshift(p);
      cursor = p.parent_id;
    }
    return out;
  })();

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <Link
        to="/locations"
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ArrowLeft size={12} /> back to all locations
      </Link>

      {breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-1 text-[11px] font-mono text-faint dark:text-slate-500">
          {breadcrumbs.map((b) => (
            <span key={b.id} className="inline-flex items-center gap-1">
              <Link to={`/locations/${b.id}`} className="hover:text-accent">
                {b.name}
              </Link>
              <ChevronRight size={11} />
            </span>
          ))}
          <span className="text-content dark:text-mortar-200">{l.name}</span>
        </nav>
      )}

      {/* The count-adjust card is a BIN affordance: "the bin of M3 screws", one
          SKU, adjust it off the bin's own QR. A ROOM is not a bin. It was
          appearing at the top of any location holding exactly one thing, so a
          kitchen with a single item in it opened on a giant +1/-5/-10 pad for
          that item, above the room's own name (reported 2026-08-22).
          `kind === "container"` is the same distinction the rest of the app
          draws between a place and a thing you put things in. */}
      {l.kind === "container" && binContents.data?.single && binContents.data.items[0] && (
        <BinAdjustModal
          inline
          locationId={l.id}
          locationName={l.name}
          item={binContents.data.items[0]}
        />
      )}

      <header className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <EntityThumb
            src={l.image_path}
            alt={l.name}
            size={96}
            className="ring-1 ring-line dark:ring-slate-700 shrink-0"
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-display font-bold text-content dark:text-mortar-100 break-words">
              {l.name}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] font-mono">
              <span className="bg-mortar-100 dark:bg-slate-800 rounded px-2 py-0.5 uppercase tracking-widest text-muted">
                {l.kind}
              </span>
              {l.short_name && (
                <span className="text-faint dark:text-slate-500">{l.short_name}</span>
              )}
            </div>
            {l.description && (
              <p className="text-sm text-content dark:text-mortar-200 mt-3">
                {l.description}
              </p>
            )}
          </div>
          {/* Its own full-width row, at EVERY width, so the name never competes
              with the buttons for space.
              This used to sit beside the title from `sm:` up, holding its
              intrinsic width (`shrink-0`) while the title absorbed every pixel
              of the shortfall. With five actions — and the set GROWS, since a
              bundle can register more — "Rack 1" wrapped to two lines on a wide
              desktop, and at narrower widths the Cobb button drew on top of the
              word it had squeezed (reported 2026-08-23).
              The name is the most important thing on the page, so it is not
              part of the negotiation. The bar already wraps internally; below
              the title it has the whole card to wrap into. */}
          <div className="order-last w-full flex flex-wrap items-center gap-1">
            <EntityActionsBar entityKind="core-locations:location" entityId={l.id} entityLabel={l.name} />
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent border border-cobble-200 dark:border-cobble-800 rounded px-2 py-1"
            >
              edit details
            </button>
          </div>
        </div>
        {l.notes && (
          <div className="mt-4 pt-3 border-t border-line dark:border-slate-700">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1">
              notes
            </div>
            <p className="text-sm text-content dark:text-mortar-200 whitespace-pre-wrap">
              {l.notes}
            </p>
          </div>
        )}
      </header>

      {/* The floor plan / layout — the location's children drawn where they
          physically stand (spec: docs/design-decisions/location-floor-plan.md).
          Rooms lay out top-down; containers (a toolbox) lay out as a front
          elevation so drawers show at true scale. */}
      {/* A drawer drawn on its toolbox's face, with nothing in it, has no
          layout to show: an empty "Layout" strip on every drawer was noise.
          A room, a standalone chest, or anything with things in it keeps it. */}
      {(l.kind === "area" || children.length > 0 || hasOwnLayout(l.metadata) || !readRect(l.metadata)) && <FloorPlan room={l} slug={activeSlug} />}

      {/* ALWAYS rendered, even with no children. It used to appear only once a
          location already had something inside it, so a room with none had no
          way to add one from its own page — you had to go back to the list and
          find its row (reported 2026-08-22). The place you are standing on is
          the obvious place to put something inside it. */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
            // sub-locations ({children.length})
          </div>
          <button
            type="button"
            onClick={() => setAddingChild(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-500/30 px-2 py-0.5 text-xs font-medium transition"
          >
            <Plus size={13} /> Add a location inside
          </button>
        </div>
        {addingChild && (
          <div className="mb-3">
            <QuickCreateLocation
              slug={activeSlug}
              all={allLocations.data?.items ?? []}
              fixedParentId={l.id}
              defaultKind="container"
              onClose={() => setAddingChild(false)}
              onCreated={() => {
                setAddingChild(false);
                void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
                toast.success(`Added inside ${l.name}`);
              }}
            />
          </div>
        )}
        {children.length === 0 && !addingChild && (
          <p className="text-sm text-faint dark:text-slate-500 italic">
            Nothing inside this one yet.
          </p>
        )}
        {children.length > 0 && (
          <>
          <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {children.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/locations/${c.id}`}
                  className="block rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
                >
                  <div className="flex items-center gap-2">
                    <MapPin size={14} className="text-accent" />
                    <span className="text-sm font-medium text-content dark:text-mortar-100">
                      {c.name}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint mt-1">
                    {c.kind}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          </>
        )}
      </section>

      <section>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
          // what's here ({contents.data?.items.length ?? 0})
        </div>
        {contents.isLoading && <div className="text-xs text-faint">loading…</div>}
        {contents.isError && (
          <div className="border border-dashed border-line dark:border-slate-700 rounded-md p-3 text-xs text-faint italic">
            Couldn't read what's stored here just now. Reload to try again.
          </div>
        )}
        {contents.data && contents.data.items.length === 0 && (
          <div className="border border-dashed border-line dark:border-slate-700 rounded-md p-6 text-center text-sm text-faint italic">
            Nothing's stored here yet. Set something's location to "{l.name}" to see it appear.
          </div>
        )}
        {contents.data && contents.data.items.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {pinnedFirst(contents.data.items).map((item) => {
              const f = item.fields ?? {};
              const template = routes.get(item.kind);
              const href = recordHref(item, template);
              const maker = str(f.manufacturer);
              const body = (
                <div className="flex items-center gap-3 min-w-0">
                  <EntityThumb src={str(f.image_path)} alt={item.title} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
                      {item.position && (
                        <MapPin size={12} className="inline mr-1 -mt-0.5 text-accent" aria-label="pinned on the plan" />
                      )}
                      {item.title}
                    </div>
                    {/* The collection, not the kind id: INVENTORY:PART under
                        a book was the review's example (2026-09-12). */}
                    <div className="text-[10px] font-mono uppercase tracking-widest text-faint truncate">
                      {labels.record(item)}
                      {maker ? ` · ${maker}` : ""}
                    </div>
                  </div>
                </div>
              );
              const card =
                "block rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3";
              return (
                <li key={`${item.kind}:${item.id}`}>
                  {/* A kind that declares no detail route has nowhere to go —
                      render it as a plain card rather than a link to "#", which
                      looks clickable and scrolls to the top of the page. */}
                  {href ? (
                    <Link
                      to={href}
                      className={card + " hover:border-cobble-300 dark:hover:border-cobble-700 transition"}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={card}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* The place's own fields: whatever a bundle or a person defines for
          places on /fields. */}
      <CustomFieldsPanel entityKind="core-locations:location" entityId={l.id} values={l.metadata ?? {}} onCommit={(name, value) => setField.mutate({ [name]: value })} />

      {/* Whatever enabled modules contribute to a place (inventory's "Stock
          here": count against minimum, what is low, what is going off); this
          page names no contributor. */}
      <ContributedDetailPanels target="core-locations:location" ctx={{ slug: activeSlug, entityId: l.id, entityTitle: l.name }} />

      <EntityAttachments kind="core-locations:location" entityId={l.id} omit={["tags", "discussion", "pairings"]} />

      <div className="flex justify-center gap-6 pt-4">
        <button
          type="button"
          onClick={() => setMoving(true)}
          className="text-xs text-faint hover:text-accent inline-flex items-center gap-1.5"
        >
          <ArrowRightLeft size={12} /> Move everything to…
        </button>
        <button
          onClick={async () => {
            let goes;
            try {
              goes = await api.locationWhatGoes(activeSlug, l.id);
            } catch (e) {
              toast.error(e instanceof ApiError ? e.message : String(e));
              return;
            }
            const ok = await confirm({
              title: `Delete "${l.name}"?`,
              message: deleteDialogMessage(goes),
              confirmLabel: goes.places > 0 ? `Delete ${countOf(goes.places + 1, "place")}` : "Delete location",
              destructive: true,
            });
            if (ok) remove.mutate();
          }}
          className="text-xs text-faint hover:text-ember-500 inline-flex items-center gap-1.5"
        >
          <Trash2 size={12} /> Delete this location
        </button>
      </div>

      {editing && (
        <EditLocationModal location={l} onClose={() => setEditing(false)} />
      )}
      {moving && (
        <MoveEverythingModal
          slug={activeSlug}
          place={l}
          placesInside={children.length}
          onClose={() => setMoving(false)}
          onMoved={(move) => {
            setMoving(false);
            const refresh = () => {
              void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
              void qc.invalidateQueries({ queryKey: ["location-contents", activeSlug] });
              void qc.invalidateQueries({ queryKey: ["location", activeSlug] });
            };
            refresh();
            toast.action(movedSentence(move), {
              actionLabel: "Undo",
              onAction: async () => {
                try {
                  const back = await api.putBackEverything(activeSlug, move);
                  refresh();
                  toast.success(putBackSentence(move, back));
                  if (move.deleted) navigate(`/locations/${move.from.id}`);
                } catch (e) {
                  toast.error(e instanceof ApiError ? e.message : String(e));
                }
              },
            });
            if (move.deleted) navigate(`/locations/${move.to.id}`);
          }}
        />
      )}
    </div>
  );
}

function EditLocationModal({
  location,
  onClose,
}: {
  location: Location;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(location.name);
  const [shortName, setShortName] = useState(location.short_name ?? "");
  const [kind, setKind] = useState<"area" | "container">(location.kind);
  const [description, setDescription] = useState(location.description ?? "");
  const [notes, setNotes] = useState(location.notes ?? "");
  // Moving a place is editing where it is: the same parent field the list's
  // form has, so a place can move from its own page too.
  const [parentId, setParentId] = useState<string | null>(location.parent_id ?? null);
  const [dup, setDup] = useState<{ existingId: string } | null>(null);
  const navigate = useNavigate();
  const places = useQuery({ queryKey: ["core-locations", activeSlug], queryFn: () => api.listLocations(activeSlug), enabled: !!activeSlug });
  const parentName = parentId ? places.data?.items.find((p) => p.id === parentId)?.name ?? null : null;
  // Declared interior size, {x,y,z} in mm (metadata.interior_mm) — what the
  // organize planner's fit checks read. Blank = undeclared (never guessed).
  const dims0 = (location.metadata?.interior_mm ?? {}) as { x?: number; y?: number; z?: number };
  const [dimX, setDimX] = useState(dims0.x != null ? String(dims0.x) : "");
  const [dimY, setDimY] = useState(dims0.y != null ? String(dims0.y) : "");
  const [dimZ, setDimZ] = useState(dims0.z != null ? String(dims0.z) : "");

  const save = useMutation({
    mutationFn: (allowDuplicate: boolean) =>
      api.updateLocation(activeSlug, location.id, {
        ...(allowDuplicate ? { allow_duplicate: true } : {}),
        parent_id: parentId,
        name: name.trim(),
        short_name: shortName.trim() || null,
        kind,
        description: description.trim() || null,
        notes: notes.trim() || null,
        // metadata is replaced wholesale by the PATCH — merge over the
        // current blob so container identity etc. survives a dims edit.
        metadata: (() => {
          const next = { ...(location.metadata ?? {}) } as Record<string, unknown>;
          const nums = [dimX, dimY, dimZ].map((v) => (v.trim() ? Number(v) : null));
          if (kind === "container" && nums.some((n) => n != null && Number.isFinite(n) && n > 0)) {
            next.interior_mm = {
              ...(nums[0] ? { x: nums[0] } : {}),
              ...(nums[1] ? { y: nums[1] } : {}),
              ...(nums[2] ? { z: nums[2] } : {}),
            };
          } else {
            delete next.interior_mm;
          }
          return next;
        })(),
      }),
    onSuccess: () => {
      toast.success("Location updated.");
      void qc.invalidateQueries({ queryKey: ["location", activeSlug, location.id] });
      void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
      void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
      onClose();
    },
    onError: (e) => {
      const found = duplicatePlaceOf(e);
      if (found) setDup(found);
      else toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });

  return (
    <Modal open onClose={onClose} title={`Edit ${location.name}`} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDup(null);
          save.mutate(false);
        }}
        className="space-y-3"
      >
        <FieldPack
          items={[
            {
              need: fieldNeed("name", { control: "text", label: "Name", valueLength: name.length }),
              node: (
                <Field label="Name">
                  <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
                </Field>
              ),
            },
            {
              need: fieldNeed("short_name", { control: "text", label: "Short name", valueLength: shortName.length }),
              node: (
                <Field label="Short name">
                  <input value={shortName} onChange={(e) => setShortName(e.target.value)} className="input" placeholder="—" />
                </Field>
              ),
            },
            {
              need: fieldNeed("kind", { control: "choice", label: "Kind", choices: ["Area", "Container"] }),
              node: (
                <Field label="Kind">
                  <select value={kind} onChange={(e) => setKind(e.target.value as "area" | "container")} className="input">
                    <option value="area">Area</option>
                    <option value="container">Container</option>
                  </select>
                </Field>
              ),
            },
            {
              need: fieldNeed("description", { control: "markdown", label: "Description" }),
              node: (
                <Field label="Description">
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="input" placeholder="One-line summary." />
                </Field>
              ),
            },
            {
              need: fieldNeed("notes", { control: "markdown", label: "Notes" }),
              node: (
                <Field label="Notes">
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="input" placeholder="Anything that helps future-you remember what lives here." />
                </Field>
              ),
            },
          ]}
        />
        <LocationTreePicker
          label="Inside"
          value={parentId}
          onChange={setParentId}
          excludeSubtreeOf={location.id}
          placeholder="(top-level)"
          noneLabel="(top-level)"
        />
        {dup && (
          <DuplicatePlaceNotice
            name={name}
            parentName={parentName}
            onOpen={() => {
              onClose();
              navigate(`/locations/${dup.existingId}`);
            }}
            onKeepBoth={() => {
              setDup(null);
              save.mutate(true);
            }}
            keepBothLabel="Keep this name anyway"
          />
        )}
        {kind === "container" && (
          <Field label="Interior size (mm) - optional">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={dimX}
                onChange={(e) => setDimX(e.target.value)}
                className="input w-24"
                placeholder="L"
                aria-label="Interior length in millimeters"
              />
              <span className="text-faint">×</span>
              <input
                type="number"
                min={1}
                value={dimY}
                onChange={(e) => setDimY(e.target.value)}
                className="input w-24"
                placeholder="W"
                aria-label="Interior width in millimeters"
              />
              <span className="text-faint">×</span>
              <input
                type="number"
                min={1}
                value={dimZ}
                onChange={(e) => setDimZ(e.target.value)}
                className="input w-24"
                placeholder="H"
                aria-label="Interior height in millimeters"
              />
            </div>
            <p className="mt-1 text-[11px] text-faint dark:text-slate-500">
              Lets Organize warn when something won't fit this container. Leave blank to skip.
            </p>
          </Field>
        )}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending || !name.trim()}
            className="flex-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium py-2 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Save size={13} /> {save.isPending ? "saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The caption over a control: the shared one, so this form's labels and a
 *  record page's read the same. */
const Field = LabeledField;

