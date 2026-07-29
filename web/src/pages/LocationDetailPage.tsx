// /locations/:id — full-entity detail view.
//
// Locations are now first-class entities (Punch-list #1 from
// docs/product/homebox-parity-report.md): notes, description, photos,
// tags, and a "what's in here" rollup that sweeps every module
// with location-bearing entities.

import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { BinAdjustModal } from "../components/BinAdjustModal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, MapPin, Save, Trash2 } from "lucide-react";
import { EntityActionsBar,
  EntityThumb,
  Modal,
  useConfirm,
  useToast, usePageTitle } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { EntityAttachments } from "../components/EntityAttachments";
import { FloorPlan } from "../components/FloorPlan";

interface ContentItem {
  module: string;
  kind: string;
  id: string;
  title: string;
  image_path?: string | null;
  manufacturer?: string | null;
}

// Modules that store entities with `location_id`. We probe each one's
// list endpoint with ?location_id=<id> and union the results.
const LOCATION_BEARING_MODULES = [
  { module: "inventory", endpoint: "/modules/inventory/parts", kind: "inventory:part", route: (id: string) => `/inventory/parts/${id}` },
  { module: "machines", endpoint: "/modules/machines/machines", kind: "machines:machine", route: (id: string) => `/machines/${id}` },
  { module: "assets", endpoint: "/modules/assets/assets", kind: "assets:asset", route: (id: string) => `/assets/${id}` },
] as const;

export function LocationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);

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

  // Contents — items + machines + assets stored here.
  const contents = useQuery({
    queryKey: ["location-contents", activeSlug, id],
    queryFn: async () => {
      const out: ContentItem[] = [];
      for (const m of LOCATION_BEARING_MODULES) {
        try {
          const data = await api.request<{
            items: Array<{
              id: string;
              name?: string;
              title?: string;
              image_path?: string | null;
              manufacturer?: string | null;
            }>;
          }>("GET", `/orgs/${activeSlug}${m.endpoint}?location_id=${id}&limit=500`);
          for (const item of data.items) {
            out.push({
              module: m.module,
              kind: m.kind,
              id: item.id,
              title: item.name ?? item.title ?? "(unnamed)",
              image_path: item.image_path,
              manufacturer: item.manufacturer,
            });
          }
        } catch {
          /* module not installed in this workspace — skip silently */
        }
      }
      return out;
    },
    enabled: !!activeSlug && !!id,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteLocation(activeSlug, id!),
    onSuccess: () => {
      toast.success("Location deleted.");
      void qc.invalidateQueries({ queryKey: ["locations", activeSlug] });
      navigate("/locations");
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
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

      {binContents.data?.single && binContents.data.items[0] && (
        <BinAdjustModal
          inline
          locationId={l.id}
          locationName={l.name}
          item={binContents.data.items[0]}
        />
      )}

      <header className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
        <div className="flex items-start gap-4">
          <EntityThumb
            src={l.image_path}
            alt={l.name}
            size={96}
            className="ring-1 ring-line dark:ring-slate-700"
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-display font-bold text-content dark:text-mortar-100">
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
          <div className="flex items-center gap-1">
            <EntityActionsBar entityKind="core-locations:location" entityId={l.id} />
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent border border-cobble-200 dark:border-cobble-800 rounded px-2 py-1"
            >
              edit
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
      <FloorPlan room={l} slug={activeSlug} />

      {children.length > 0 && (
        <section>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
            // sub-locations ({children.length})
          </div>
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
        </section>
      )}

      <section>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
          // what's here ({contents.data?.length ?? 0})
        </div>
        {contents.isLoading && (
          <div className="text-xs text-faint">loading…</div>
        )}
        {contents.data && contents.data.length === 0 && (
          <div className="border border-dashed border-line dark:border-slate-700 rounded-md p-6 text-center text-sm text-faint italic">
            Nothing's stored here yet. Set a part / machine / asset's
            location to "{l.name}" to see it appear.
          </div>
        )}
        {contents.data && contents.data.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {contents.data.map((item) => {
              const m = LOCATION_BEARING_MODULES.find((x) => x.module === item.module);
              const href = m ? m.route(item.id) : "#";
              return (
                <li key={`${item.module}:${item.id}`}>
                  <Link
                    to={href}
                    className="block rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <EntityThumb
                        src={item.image_path}
                        alt={item.title}
                        size={40}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
                          {item.title}
                        </div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
                          {item.kind}
                          {item.manufacturer ? ` · ${item.manufacturer}` : ""}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <EntityAttachments kind="core-locations:location" entityId={l.id} />

      <div className="text-center pt-4">
        <button
          onClick={async () => {
            const ok = await confirm({
              title: `Delete "${l.name}"?`,
              message:
                children.length > 0
                  ? `${children.length} sub-location${children.length === 1 ? "" : "s"} will also be deleted (cascade). Items stored here will be orphaned (location_id → null).`
                  : "Items stored here will be orphaned (location_id → null).",
              confirmLabel: "Delete location",
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
  // Declared interior size, {x,y,z} in mm (metadata.interior_mm) — what the
  // organize planner's fit checks read. Blank = undeclared (never guessed).
  const dims0 = (location.metadata?.interior_mm ?? {}) as { x?: number; y?: number; z?: number };
  const [dimX, setDimX] = useState(dims0.x != null ? String(dims0.x) : "");
  const [dimY, setDimY] = useState(dims0.y != null ? String(dims0.y) : "");
  const [dimZ, setDimZ] = useState(dims0.z != null ? String(dims0.z) : "");

  const save = useMutation({
    mutationFn: () =>
      api.updateLocation(activeSlug, location.id, {
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
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Edit ${location.name}`} size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <Field label="Name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short name">
            <input
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              className="input"
              placeholder="—"
            />
          </Field>
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as "area" | "container")}
              className="input"
            >
              <option value="area">Area</option>
              <option value="container">Container</option>
            </select>
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="input"
            placeholder="One-line summary."
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className="input"
            placeholder="Anything that helps future-you remember what lives here."
          />
        </Field>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

