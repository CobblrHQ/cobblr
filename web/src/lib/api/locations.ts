import type { PlanDraftBody } from "@cobblr/platform-contract/plan-draft";
import { request } from "./client";
import type { AddressSuggestionsBody } from "@cobblr/platform-web";

export interface LocationImportRow {
  row_number: number;
  name: string;
  short_name: string | null;
  kind: "area" | "container";
  match_value: string | null;
  action: "create" | "update";
  parent: { key: string; resolved: boolean; path?: string | null } | null;
  /** The place's full path, "Attic › Shelf 1", once its parent is known. */
  path?: string | null;
  metadata: Record<string, string>;
  /** Why this row cannot be imported as written; the whole file waits on it. */
  error?: string | null;
}
export interface LocationImportResponse {
  match_on?: string;
  detected_headers?: string[];
  rows?: LocationImportRow[];
  errors: { row_number: number; message: string }[];
  /** Rows the file cannot be imported with until they are written apart. */
  blocking?: { row_number: number; message: string }[];
  summary?: { create: number; update: number; unresolved_parents: number; blocked?: number };
  committed: number;
  created?: number;
  updated?: number;
}

/** What "Move everything to…" did: enough to say it and to put it back. */
export interface PlaceMove {
  from: { id: string; name: string };
  /** `kind` is set when it went into a thing that holds things, not a place. */
  to: { id: string; name: string; kind?: string };
  things: Array<{ kind: string; id: string; slot: string | null; position: unknown }>;
  places: string[];
  deleted: boolean;
}

export interface Location {
  /** Direct placements, supplied by the workspace locations list. */
  contents_count?: number;
  id: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  depth: number;
  position: number;
  kind: "area" | "container";
  metadata: Record<string, unknown>;
  description: string | null;
  notes: string | null;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

/** A thing inside a container, with where in it: its slot, and the exact spot
 *  a floor plan pinned it at (in the container's plan's mm), or null. */
/** A planning layout for a room: what would move, until it is applied. */
export interface PlanDraft {
  id: string;
  location_id: string;
  name: string;
  body: PlanDraftBody;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  /** While applied: each planned key and the real place Apply made of it. */
  made?: Record<string, string> | null;
}

/** What a floor plan import did (or, on a dry run, would do). */
export interface FloorplanImportResult {
  dry_run: boolean;
  steps: Array<{ path: string; kind: "area" | "container"; action: "create" | "update" | "unchanged" }>;
  warnings: string[];
  created: string[];
  updated: Array<{ id: string; before: unknown }>;
  note: string;
}

export const locationsApi = {

  // Placement — containment (core-placement). "What's inside this container?"
  // and "what is this thing installed in?"
  // Planning layouts (core-locations plan-drafts.ts): a room's drafts, which
  // move nothing until applied.
  planDrafts: (slug: string, locationId: string) =>
    request<{ items: PlanDraft[] }>("GET", `/orgs/${slug}/modules/core-locations/locations/${locationId}/plan-drafts`),
  planDraftCreate: (slug: string, locationId: string, body: { name?: string; from?: string }) =>
    request<PlanDraft>("POST", `/orgs/${slug}/modules/core-locations/locations/${locationId}/plan-drafts`, body),
  planDraftUpdate: (slug: string, id: string, body: { name?: string; body?: PlanDraftBody }) =>
    request<PlanDraft>("PATCH", `/orgs/${slug}/modules/core-locations/locations/plan-drafts/${id}`, body),
  planDraftDelete: (slug: string, id: string) => request<void>("DELETE", `/orgs/${slug}/modules/core-locations/locations/plan-drafts/${id}`),
  /** `body`, the layout the person confirmed: applied only if it is the one saved. */
  planDraftApply: (slug: string, id: string, body?: PlanDraftBody) =>
    request<{ note: string; things: unknown[]; moved: unknown[]; created: unknown[] }>("POST", `/orgs/${slug}/modules/core-locations/locations/plan-drafts/${id}/apply`, body ? { body } : undefined),
  planDraftUndo: (slug: string, id: string) =>
    request<{ note: string }>("POST", `/orgs/${slug}/modules/core-locations/locations/plan-drafts/${id}/undo`),
  // A whole house as one file (cobblr-floorplan/1, core-locations floorplan-file.ts).
  floorplanImport: (slug: string, plan: unknown, dryRun: boolean) =>
    request<FloorplanImportResult>("POST", `/orgs/${slug}/modules/core-locations/locations/floorplan/import`, { plan, dry_run: dryRun }),
  floorplanImportUndo: (slug: string, imp: { created: string[]; updated: unknown[] }) =>
    request<{ note: string }>("POST", `/orgs/${slug}/modules/core-locations/locations/floorplan/import/undo`, { import: imp }),
  floorplanExport: (slug: string, locationId: string) =>
    request<Record<string, unknown>>("GET", `/orgs/${slug}/modules/core-locations/locations/${locationId}/floorplan/export`),
  /** Where a thing is, every step up: "Headphones" → "Backpack, in Desk drawer". */
  requestLight: (slug: string, ref: { kind: string; id: string }, reason: "shown" | "found" | "picked" | "put-away" | "label-scanned" = "found") =>
    request<{ requested: boolean; place: string | null; note: string }>("POST", `/orgs/${slug}/modules/core-locations/locations/lights/request`, { ...ref, reason }),
  lightConnections: (slug: string) => request<{ items: import("@cobblr/platform-contract/services").ServiceConnectionHolder[] }>("GET", `/orgs/${slug}/modules/core-locations/locations/lights`),
  setPlaceLight: (slug: string, id: string, mapping: import("@cobblr/platform-contract/place-indicate").PlaceLightMapping | null) =>
    request<{ saved: boolean }>("PUT", `/orgs/${slug}/modules/core-locations/locations/${id}/light`, { mapping }),
  setGridLights: (slug: string, id: string, grid: import("@cobblr/platform-contract/place-indicate").LightGridInput) =>
    request<{ mapped: number }>("POST", `/orgs/${slug}/modules/core-locations/locations/${id}/light-grid`, grid),
  /** What a field already holds across a kind's records, for the choice
   *  picker (GET /field-values). Growing a field's choices is
   *  platform:learn-choice, never a client-side read-modify-write. */
  /** The addresses this workspace already used, matching `q`, for the address
   *  picker (GET /addresses); `lookup` is null when no map lookup is set. */
  addresses: (slug: string, q: string) =>
    request<AddressSuggestionsBody>("GET", `/orgs/${slug}/addresses?${new URLSearchParams({ q }).toString()}`),

  // core-locations — workspace-wide tree of physical places. Anything
  // with a `location_id` field (machines, assets, parts) points at
  // rows from this endpoint.
  listLocations: (slug: string) =>
    request<{ items: Location[] }>(
      "GET",
      `/orgs/${slug}/modules/core-locations/locations`,
    ),
  getLocation: (slug: string, id: string) =>
    request<Location>(
      "GET",
      `/orgs/${slug}/modules/core-locations/locations/${id}`,
    ),
  /** `allow_duplicate`: a person who saw the place already there and still
   *  wants a second one of that name under the same parent. */
  createLocation: (slug: string, body: Partial<Location> & { allow_duplicate?: boolean }) =>
    request<Location>(
      "POST",
      `/orgs/${slug}/modules/core-locations/locations`,
      body,
    ),
  /** `headers` from editOf: what the edited fields were when the form opened. */
  updateLocation: (slug: string, id: string, body: Partial<Location> & { allow_duplicate?: boolean }, headers?: Record<string, string>) =>
    request<Location>(
      "PATCH",
      `/orgs/${slug}/modules/core-locations/locations/${id}`,
      body,
      headers,
    ),
  /** Deletes the place, every place inside it, and takes out what was kept
   *  there; says how much went, for the Undo toast. */
  deleteLocation: (slug: string, id: string) =>
    request<{ deleted: true; name: string; places: number; things: number }>(
      "DELETE",
      `/orgs/${slug}/modules/core-locations/locations/${id}`,
    ),
  /** Move everything kept in a place into another; `places` moves the places
   *  inside it too, `then_delete` merges (moves all, deletes the empty one).
   *  The answer is the move itself, which `putBackEverything` undoes. */
  moveEverything: (slug: string, id: string, body: { to: string; to_kind?: string; places?: boolean; then_delete?: boolean }) =>
    request<PlaceMove>("POST", `/orgs/${slug}/modules/core-locations/locations/${id}/move-everything`, body),
  putBackEverything: (slug: string, move: PlaceMove) =>
    request<{ things: number; places: number; leftWhereTheyAre: number }>(
      "POST",
      `/orgs/${slug}/modules/core-locations/locations/move-everything/undo`,
      { move },
    ),
  /** What deleting a place would take with it, for the dialog. `needs` names
   *  the permission a member lacks when there are places inside. */
  locationWhatGoes: (slug: string, id: string) =>
    request<{ places: number; things: number; needs: string | null }>(
      "GET",
      `/orgs/${slug}/modules/core-locations/locations/${id}/what-goes`,
    ),
  /** Undo a place delete: the place, the places inside it, and each thing
   *  back where it was (unless it has been put somewhere else since). */
  restoreDeletedLocation: (slug: string, id: string) =>
    request<{ restored: true; name: string; places: number; things: number; leftWhereTheyAre: number }>(
      "POST",
      `/orgs/${slug}/modules/core-locations/locations/deleted/${id}/restore`,
    ),
  importLocations: (slug: string, body: { csv: string; match_on?: string; dry_run?: boolean }) =>
    request<LocationImportResponse>("POST", `/orgs/${slug}/modules/core-locations/locations/import`, body),
  exportLocationsPath: (slug: string) => `/orgs/${slug}/modules/core-locations/locations/export`,
  // Persist a sibling group's display order: `ids` in the desired order → each
  // row's `position` set to its index. Siblings render by (position, name).
  reorderLocations: (slug: string, ids: string[]) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-locations/locations/reorder`, { ids }),
  /** Describe-to-plan: an AI drafts room dims + walls (+ door openings) +
   *  zone regions from prose. dry_run returns the validated draft without
   *  writing (the preview + eval path). */
  seedFloorplan: (slug: string, id: string, description: string, dry_run?: boolean) =>
    request<{
      draft: {
        room: {
          w_mm: number;
          d_mm: number;
          unit?: string;
          view?: string;
          walls?: Array<{
            x1: number; y1: number; x2: number; y2: number;
            openings?: Array<{ at_mm: number; w_mm: number }>;
          }>;
        };
        zones: Array<{ name: string; rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number } }>;
      };
      applied: boolean;
      zones?: Array<{ name: string; id: string; created: boolean }>;
    }>("POST", `/orgs/${slug}/modules/core-locations/locations/${id}/floorplan/seed`, {
      description,
      ...(dry_run ? { dry_run } : {}),
    }),
};
