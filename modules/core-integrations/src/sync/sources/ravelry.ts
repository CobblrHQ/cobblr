// Ravelry — a built-in declarative sync source. Mirrors a user's Ravelry stash
// (and, if they enable it, their projects) into a Cobblr entity of their choosing.
// It is DATA, not code: nothing Ravelry-specific lives in the engine — this
// manifest just declares auth, endpoints, and field maps, and the declarative
// engine (../declarative.ts) interprets it. Registered as a built-in so it
// appears in every workspace's "Add a connection" picker, opt-in.
//
// Decoupled from the Yarn bundle on purpose: the user picks WHICH inventory
// instance the stash lands in (the per-connection target-instance picker), so a
// hand-rolled yarn table works as well as the flagship one. Unit fields (length
// per skein) are stored RAW in metres — core-units + the field's declared unit +
// the viewer's preference handle any yd/m display conversion (never the importer;
// see scripts/lint-unit-conversion.ts).
//
// Ravelry API: HTTP Basic with a read-only "personal" key (access_key = username,
// personal_key = password). `/current_user.json` resolves the account username,
// which the stash/projects list paths embed. Docs: https://www.ravelry.com/api

import { SyncSourceManifest } from "../manifest.js";

// Parsed through the schema at load → zod defaults fill in (pagination bounds
// etc.) and a malformed manifest fails fast at boot instead of at first use.
export const RAVELRY_MANIFEST = SyncSourceManifest.parse({
  id: "ravelry",
  name: "Ravelry",
  version: "1.0.0",
  baseUrl: "https://api.ravelry.com",
  credentials: {
    access_key: { label: "Access key (username)", secret: false },
    personal_key: { label: "Personal key (password)", secret: true },
  },
  auth: { kind: "basic", userFrom: "access_key", passFrom: "personal_key" },
  // Resolve the account's username first — the list endpoints are per-person.
  resolveVars: {
    username: { method: "GET", path: "/current_user.json", at: "$.user.username" },
  },
  // Cheap probe: if /current_user resolves, the creds are valid.
  test: { method: "GET", path: "/current_user.json" },
  entityTypes: [
    {
      key: "stash",
      label: "Yarn stash",
      targetKind: "inventory:part",
      idField: "$.id",
      list: {
        method: "GET",
        path: "/people/{username}/stash/list.json",
        arrayPath: "$.stash",
        paginate: { param: "page", sizeParam: "page_size", size: 100 },
      },
      // Single-item refetch (unused today — Ravelry has no webhooks — but keeps
      // the section self-describing if a poll ever wants one row).
      item: {
        method: "GET",
        path: "/people/{username}/stash/{externalId}.json",
        itemPath: "$.stash",
      },
      map: {
        name: { coalesce: ["$.name", "$.yarn_name", "$.yarn.name", "$.colorway", "='Yarn'"] },
        // Native inventory field.
        manufacturer: { coalesce: ["$.yarn_company_name", "$.yarn.yarn_company.name"] },
        // Skeins on hand: explicit pack count → quantity text → 1.
        qty: { coalesce: ["$.packs.0.skeins", "$.quantity_description", "='1'"] },
        // Yarn-shaped custom fields — land where the target instance declares
        // them (the Yarn bundle does; a hand-rolled table gets whatever it has).
        colorway: "$.colorway",
        fiber: "$.yarn.yarn_fibers.0.fiber_type.name",
        weight_class: {
          from: "$.yarn_weight.name",
          valueMap: {
            Lace: "0 – Lace",
            Cobweb: "0 – Lace",
            Thread: "0 – Lace",
            "Light Fingering": "1 – Fingering",
            Fingering: "1 – Fingering",
            Sock: "1 – Fingering",
            Sport: "2 – Sport",
            DK: "3 – DK",
            Worsted: "4 – Worsted",
            Afghan: "4 – Worsted",
            Aran: "4 – Aran",
            Bulky: "5 – Bulky",
            Craft: "5 – Bulky",
            "Super Bulky": "6 – Super Bulky",
            Jumbo: "6 – Super Bulky",
          },
        },
        // Length per skein in METRES, stored raw — display conversion is core-units'
        // job, never this importer's (lint-unit-conversion.ts).
        length_per_skein: {
          coalesce: ["$.packs.0.meters_per_skein", "$.meters_per_skein", "$.yarn.meters_per_skein"],
        },
        dye_lot: "$.dye_lot",
        notes: "$.notes",
      },
      images: { image_path: "$.photos.0.medium_url" },
    },
    {
      key: "projects",
      label: "Projects",
      targetKind: "projects:project",
      idField: "$.id",
      list: {
        method: "GET",
        path: "/projects/{username}/list.json",
        arrayPath: "$.projects",
        paginate: { param: "page", sizeParam: "page_size", size: 100 },
      },
      item: {
        method: "GET",
        path: "/projects/{username}/{externalId}.json",
        itemPath: "$.project",
      },
      map: {
        name: { coalesce: ["$.name", "='Project'"] },
        description: { coalesce: ["$.notes", "$.notes_html"] },
        status: {
          from: "$.status_name",
          valueMap: {
            Finished: "done",
            "In progress": "active",
            Hibernating: "blocked",
            Frogged: "abandoned",
            "In dye pot": "active",
            Steeked: "active",
          },
          default: "active",
        },
        start_date: { coalesce: ["$.started", "$.started_day"] },
        completion_date: { coalesce: ["$.completed", "$.completed_day"] },
      },
      images: { image_path: "$.first_photo.medium_url" },
    },
  ],
});
