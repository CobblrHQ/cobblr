// Homebox — a built-in declarative sync source (DATA, not code). Mirrors a
// self-hosted Homebox instance's items + locations (+ photos) into this
// workspace. Verified against a live Homebox v0.26 during the 2026-07-09
// migration proof; the three engine features it leans on (tree-flatten,
// hydrate, templated image URLs) were added for exactly this shape.
//
// Homebox v0.26 model quirks this manifest handles:
//   • Items + locations are ONE "entities" table, split by entityType.isLocation.
//   • GET /entities returns only THINGS (summary) — full fields (serial,
//     warranty, manufacturer, custom fields) live in GET /entities/{id}, so the
//     items section is `hydrate: true`.
//   • Locations have no flat list — only the nested /entities/tree — so the
//     locations section uses `list.tree` (the engine flattens it, stamping
//     __parent_id) + a type filter.
//   • An item's location is its PARENT entity (parent.id) → resolved via a
//     cross-section reference into the locations section.
//   • The photo is an attachment fetched at /entities/{id}/attachments/{imageId}
//     — composed with a templated image URL.
//
// Auth: a Homebox API key (Settings → API keys), sent as `Authorization: Bearer
// <key>`. Base URL is the user's own instance (self-hosted), so there's no fixed
// baseUrl — the "Add connection" form asks for it (edge transport reaches a LAN
// Homebox through the workspace's bridge).

import { SyncSourceManifest } from "../manifest.js";

export const HOMEBOX_MANIFEST = SyncSourceManifest.parse({
  id: "homebox",
  name: "Homebox",
  version: "1.0.0",
  baseUrlLabel: "Homebox URL",
  baseUrlPlaceholder: "http://homebox.local:3100",
  credentials: {
    token: { label: "API key (Homebox → Settings → API keys)", secret: true },
  },
  auth: { kind: "header", header: "Authorization", from: "token", prefix: "Bearer " },
  // Cheap probe: /users/self resolves iff the key is valid.
  test: { method: "GET", path: "/api/v1/users/self" },
  entityTypes: [
    {
      key: "locations",
      label: "Locations (rooms, shelves, bins)",
      targetKind: "core-locations:location",
      // Locations only exist in the nested tree — flatten it (engine stamps
      // __parent_id from the nesting) and keep only the location nodes.
      list: { method: "GET", path: "/api/v1/entities/tree", tree: { children: "children" } },
      filter: { from: "$.type", equals: "location" },
      idField: "$.id",
      parentField: "$.__parent_id",
      map: {
        name: "$.name",
        // Source-specific data is namespaced under `homebox` so it can't collide
        // with Cobblr's own metadata keys (lifecycle / state / status / …).
        metadata: { object: { homebox: { object: { source: "='homebox'", ext_id: "$.id" } } } },
      },
    },
    {
      key: "items",
      label: "Items",
      targetKind: "inventory:part",
      list: {
        method: "GET",
        path: "/api/v1/entities",
        arrayPath: "$.items",
        paginate: { param: "page", sizeParam: "pageSize", size: 100 },
      },
      // The list is summary-only — re-fetch each item's full record.
      hydrate: true,
      item: { method: "GET", path: "/api/v1/entities/{externalId}", itemPath: undefined },
      idField: "$.id",
      // An item's location is its parent entity — resolve into the locations section.
      references: {
        location_id: { section: "locations", from: "$.parent.id" },
      },
      map: {
        name: "$.name",
        description: "$.description",
        qty: { coalesce: ["$.quantity", "='1'"] },
        cost: "$.purchasePrice",
        manufacturer: "$.manufacturer",
        notes: "$.notes",
        serial_number: "$.serialNumber",
        model_number: "$.modelNumber",
        insured: "$.insured",
        archived: "$.archived",
        lifetime_warranty: "$.lifetimeWarranty",
        warranty_expires: "$.warrantyExpires",
        // Everything Cobblr has no native column for, kept losslessly — all
        // namespaced under `homebox` so it can't collide with Cobblr's own
        // metadata keys (lifecycle / state / status / …).
        metadata: {
          object: {
            homebox: {
              object: {
                source: "='homebox'",
                ext_id: "$.id",
                asset_id: "$.assetId",
                purchase_from: "$.purchaseFrom",
                purchase_date: "$.purchaseDate",
                fields: "$.fields",
                // Tags ride along losslessly: the sync engine writes one target
                // kind (the part) — it can't attach core-tags — so Homebox labels
                // are kept here rather than lost. (Real tag attachment would need
                // an engine feature; the one-shot CSV importer does attach them.)
                tags: "$.tags",
              },
            },
          },
        },
      },
      // Compose the attachment URL from the item id + its primary image id.
      images: { image_path: "/api/v1/entities/{$.id}/attachments/{$.imageId}" },
    },
  ],
});
