// Snipe-IT — a built-in declarative sync source (DATA, not code). Mirrors a
// self-hosted Snipe-IT instance's locations and hardware (assets) into this
// workspace, from its documented REST API (v1).
//
// Snipe-IT model notes this manifest handles:
//   • Every collection answers `{ total, rows: [...] }` and pages by `limit` and
//     `offset` (rows skipped), not by page number.
//   • Relations come back embedded as `{ id, name }` (model, category,
//     manufacturer, supplier, location, status), so one list call carries all
//     of them. Cobblr assets hold their type (Snipe-IT's category), maker and
//     model as plain text, so categories, models and manufacturers ride on each
//     asset rather than being sections of their own.
//   • A location's parent is `parent: { id, name }` or null.
//   • An asset's place is the location it is checked out to when it has one
//     (`location`), else its default home (`rtd_location`).
//   • `purchase_cost` is text as a person writes it ("1,249.99"): `|cents`.
//   • `purchase_date` and `warranty_expires` are `{ date, formatted }`.
//   • `image` is an absolute URL on the Snipe-IT host (or null). The token goes
//     only to that host.
//   • An asset's name is optional in Snipe-IT; the model's name stands in, then
//     the asset tag.
//
// Auth: a Snipe-IT personal API token (Account → Manage API keys), sent as
// `Authorization: Bearer <token>`. The base URL is the user's own instance.

import { SyncSourceManifest } from "../manifest.js";

const PAGINATE = { param: "offset", sizeParam: "limit", size: 100, offset: true };

export const SNIPEIT_MANIFEST = SyncSourceManifest.parse({
  id: "snipeit",
  name: "Snipe-IT",
  version: "1.0.0",
  baseUrlLabel: "Snipe-IT URL",
  baseUrlPlaceholder: "https://snipeit.example.com",
  credentials: {
    token: { label: "API token (Snipe-IT → Account → Manage API keys)", secret: true },
  },
  auth: { kind: "header", header: "Authorization", from: "token", prefix: "Bearer " },
  // Cheap probe: resolves iff the token is valid.
  test: { method: "GET", path: "/api/v1/users/me" },
  entityTypes: [
    {
      key: "locations",
      label: "Locations",
      targetKind: "core-locations:location",
      list: { method: "GET", path: "/api/v1/locations", arrayPath: "$.rows", paginate: PAGINATE },
      idField: "$.id",
      parentField: "$.parent.id",
      map: {
        name: "$.name",
        metadata: { object: { snipeit: { object: { source: "='snipeit'", ext_id: "$.id" } } } },
      },
    },
    {
      key: "hardware",
      label: "Assets",
      targetKind: "assets:asset",
      list: { method: "GET", path: "/api/v1/hardware", arrayPath: "$.rows", paginate: PAGINATE },
      idField: "$.id",
      references: {
        location_id: { section: "locations", from: "$.location.id", fallback: "$.rtd_location.id" },
      },
      images: { image_path: "$.image" },
      map: {
        name: { coalesce: ["$.name", "$.model.name", "$.asset_tag"] },
        // The tag printed on the asset: the short name is a native, searchable
        // field, and the tag is kept whole in the details as well.
        short_name: "$.asset_tag",
        serial_number: "$.serial",
        type: "$.category.name",
        manufacturer: "$.manufacturer.name",
        model: "$.model.name",
        vendor: "$.supplier.name",
        notes: "$.notes",
        purchased_at: "$.purchase_date.date",
        warranty_until: "$.warranty_expires.date",
        purchase_price_cents: "$.purchase_cost|cents",
        metadata: {
          object: {
            snipeit: {
              object: {
                source: "='snipeit'",
                ext_id: "$.id",
                asset_tag: "$.asset_tag",
                status: "$.status_label.name",
                order_number: "$.order_number",
                company: "$.company.name",
                model_number: "$.model_number",
                warranty_months: "$.warranty_months",
                custom_fields: "$.custom_fields",
              },
            },
          },
        },
      },
    },
  ],
});
