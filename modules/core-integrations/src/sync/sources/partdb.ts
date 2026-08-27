// Part-DB — a built-in declarative sync source (DATA, not code). Mirrors a
// self-hosted Part-DB instance's storage locations, categories and parts into
// this workspace. Verified against Part-DB 2.4.0.1 (API Platform 4.x); the
// measured contract is in docs/product/partdb-analysis.md.
//
// Part-DB model notes this manifest handles:
//   • Relations EMBED as objects ({name, id, full_path}), so no `hydrate` is
//     needed: one list call carries category, manufacturer, lots and suppliers.
//   • Collections are a bare JSON array under `Accept: application/json`, so no
//     `arrayPath`. Requesting `.jsonld` under that header returns an error.
//   • `parent` on a structural element is an IRI ("/api/storage_locations/1"),
//     hence `|last`.
//   • Stock lives on part LOTS and a part can have several. Cobblr has one
//     location per part today, so the first lot wins and every lot is kept in
//     metadata; the import UI counts multi-lot parts and says so.
//   • `minamount` defaults to 0 meaning "no minimum"; Cobblr reads a non-null
//     min_qty as a reorder point, so 0 is mapped to null.
//   • The master picture's `media_url` is a path on the Part-DB host for an
//     uploaded file ("/media/part/2/photo-….png") and an absolute third-party
//     URL for an external one; both measured. The engine fetches either, and
//     sends the token only to the Part-DB host (never to a third party).
//
// Auth: a Part-DB API token (User settings → API tokens). READ-ONLY is enough.
// The token's user or group must also hold the `api.access_api` permission or
// every call 403s; the connection test surfaces that as "→ 403".

import { SyncSourceManifest } from "../manifest.js";

const PAGINATE = { param: "page", sizeParam: "itemsPerPage", size: 100 };

export const PARTDB_MANIFEST = SyncSourceManifest.parse({
  id: "partdb",
  name: "Part-DB",
  version: "1.0.0",
  baseUrlLabel: "Part-DB URL",
  baseUrlPlaceholder: "http://parts.local:8080",
  credentials: {
    token: { label: "API token (Part-DB → User settings → API tokens)", secret: true },
  },
  auth: { kind: "header", header: "Authorization", from: "token", prefix: "Bearer " },
  // Cheap probe: resolves iff the token is valid AND api.access_api is granted.
  test: { method: "GET", path: "/api/tokens/current" },
  entityTypes: [
    {
      key: "locations",
      label: "Storage locations (rooms, shelves, bins)",
      targetKind: "core-locations:location",
      list: { method: "GET", path: "/api/storage_locations.json", paginate: PAGINATE },
      idField: "$.id",
      parentField: "$.parent|last",
      map: {
        name: "$.name",
        metadata: {
          object: {
            partdb: {
              object: {
                source: "='partdb'",
                ext_id: "$.id",
                full_path: "$.full_path",
                comment: "$.comment",
              },
            },
          },
        },
      },
    },
    {
      key: "categories",
      label: "Categories",
      targetKind: "inventory:category",
      list: { method: "GET", path: "/api/categories.json", paginate: PAGINATE },
      idField: "$.id",
      parentField: "$.parent|last",
      // No metadata: inventory_categories has no metadata column.
      map: { name: "$.name" },
    },
    {
      key: "parts",
      label: "Parts",
      targetKind: "inventory:part",
      list: { method: "GET", path: "/api/parts.json", paginate: PAGINATE },
      // Single-part refetch. The list is already full, so deliberately NO hydrate.
      item: { method: "GET", path: "/api/parts/{externalId}.json" },
      images: { image_path: "$.master_picture_attachment.media_url" },
      idField: "$.id",
      // Part-DB's tags field is one comma-separated string.
      tags: { from: "$.tags", split: "," },
      references: {
        // First lot wins; every lot is kept in metadata.partdb.lots.
        location_id: { section: "locations", from: "$.partLots.0.storage_location.id" },
        category_id: { section: "categories", from: "$.category.id" },
      },
      map: {
        name: "$.name",
        description: "$.description",
        notes: "$.comment",
        // Part-DB pre-sums stock across lots, so no client-side arithmetic.
        qty: { coalesce: ["$.total_instock", "='0'"] },
        min_qty: { from: "$.minamount", valueMap: { "0": "" } },
        manufacturer: "$.manufacturer.name",
        model_number: "$.manufacturer_product_number",
        unit: { coalesce: ["$.partUnit.unit", "='each'"] },
        supplier_url: "$.orderdetails.0.supplier_product_url",
        // Everything Cobblr has no native column for, namespaced under `partdb`
        // so it cannot collide with Cobblr's own metadata keys.
        metadata: {
          object: {
            partdb: {
              object: {
                source: "='partdb'",
                ext_id: "$.id",
                ipn: "$.ipn",
                mass: "$.mass",
                gtin: "$.gtin",
                favorite: "$.favorite",
                needs_review: "$.needs_review",
                category: "$.category.full_path",
                footprint: "$.footprint.full_path",
                manufacturer_product_url: "$.manufacturer_product_url",
                manufacturing_status: "$.manufacturing_status",
                lots: "$.partLots",
                orderdetails: "$.orderdetails",
                parameters: "$.parameters",
                eda_info: "$.eda_info",
                added_date: "$.addedDate",
                last_modified: "$.lastModified",
              },
            },
          },
        },
      },
    },
  ],
});
