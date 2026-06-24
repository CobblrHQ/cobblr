// Declarative sync-source manifest — describes how to mirror an external HTTP
// API's entities into Cobblr as DATA, so a user adds a sync source (companion app,
// a Notion DB, a sheet, …) by INSTALLING a manifest — no platform deploy, nothing
// source-specific compiled into the kernel. The declarative engine
// (./declarative.ts) interprets one of these into a SyncConnector.
//
// This mirrors digifab's declarative machine-driver manifests
// (modules/digifab/src/drivers/manifest.ts) — same idea, applied to entity sync.
//
// Field-map value grammar (a FieldSpec, recursive):
//   "$.a.b.c"                              — dot-path into the source record
//   "='literal'"                           — a literal string
//   { from, valueMap?, default? }          — read `from`, optionally remap the
//                                            value via valueMap, else `default`
//   { object: { k: FieldSpec, … } }        — a nested object (e.g. metadata)
//
// See docs/modules/sync-sources.md.

import { z } from "zod";

/** A dot-path (`$.x.y`) or literal (`='lit'`) string extract. */
const Extract = z.string().min(1);
const Method = z.enum(["GET", "POST"]).default("GET");

/** A field mapping value — recursive (nested objects + value remaps). */
export type FieldSpec =
  | string
  | { from: string; valueMap?: Record<string, string>; default?: unknown }
  | { object: Record<string, FieldSpec> };

export const FieldSpec: z.ZodType<FieldSpec> = z.lazy(() =>
  z.union([
    Extract,
    z.object({
      from: Extract,
      valueMap: z.record(z.string()).optional(),
      default: z.unknown().optional(),
    }),
    z.object({ object: z.record(FieldSpec) }),
  ]),
);

export const SyncEntityTypeManifest = z.object({
  /** Stable key for this entity type, e.g. "locations". */
  key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(120),
  /** The Cobblr entity kind to write into, e.g. "core-locations:location". */
  targetKind: z.string().min(1).max(120),
  /** List endpoint (fetchAll). `arrayPath` points at the array inside the
   *  response (e.g. "$.items"); omit if the body IS the array. */
  list: z.object({
    method: Method,
    path: z.string().min(1),
    arrayPath: z.string().optional(),
  }),
  /** Optional single-item endpoint (fetchOne, for webhook-targeted refetch).
   *  `{externalId}` in the path is substituted. `itemPath` points at the object
   *  inside the response (e.g. "$.item"); omit if the body IS the object. */
  item: z
    .object({ method: Method, path: z.string().min(1), itemPath: z.string().optional() })
    .optional(),
  /** Extract for the source record's stable external id (e.g. "$.id"). */
  idField: Extract,
  /** Extract for the parent's external id (hierarchy), or omit for flat. */
  parentField: Extract.optional(),
  /** Source-field → target-field mapping. */
  map: z.record(FieldSpec),
});
export type SyncEntityTypeManifest = z.infer<typeof SyncEntityTypeManifest>;

export const SyncSourceManifest = z.object({
  /** Source key — what a connection's connector_id references. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  version: z.string().max(32).optional(),
  /** Optional human hint shown next to the credential field. */
  credentialLabel: z.string().max(80).optional(),
  baseUrlLabel: z.string().max(80).optional(),
  baseUrlPlaceholder: z.string().max(120).optional(),
  /** Header auth: send `header: <prefix?><credential value `from`>`. e.g.
   *  { header: "Authorization", from: "token", prefix: "Bearer " }. */
  auth: z
    .object({
      kind: z.literal("header"),
      header: z.string().min(1),
      from: z.string().min(1).default("token"),
      prefix: z.string().optional(),
    })
    .nullable()
    .optional(),
  /** Cheap connectivity probe (defaults to the first entity type's list path). */
  test: z.object({ method: Method, path: z.string().min(1) }).optional(),
  entityTypes: z.array(SyncEntityTypeManifest).min(1),
  /** Webhook body shape, if the source pushes live changes. `entityField`
   *  identifies which entity type fired; `entityValueMap` maps the source's
   *  value to a manifest entityType key. */
  webhook: z
    .object({
      entityField: Extract,
      entityValueMap: z.record(z.string()).optional(),
      idField: Extract,
      deletedField: Extract.optional(),
      deletedWhen: z.string().optional(),
      /** If the webhook body carries the full record, where it lives (e.g.
       *  "$.record"). When set, the engine applies it directly instead of
       *  re-fetching via the item endpoint. */
      recordPath: Extract.optional(),
    })
    .optional(),
});
export type SyncSourceManifest = z.infer<typeof SyncSourceManifest>;
