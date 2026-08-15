// core-file-preview — read-only previews of job/attachment files.
//
// A capability (ambient plumbing), not a domain: no nav noun, no table,
// no entity kinds. It contributes a *renderer* — given a stored file, it
// renders a preview (STL/GCODE/SVG today; DXF/3MF/STEP next). The renderers
// register into platform-web's FilePreview registry on UI load, so any
// surface that shows a file (digifab job views, attachment panels, the App
// Player) previews it WITHOUT importing this module.
//
// Strictly preview, never CAD: it renders geometry, it never authors,
// slices, repairs, or transforms it — that stays the upstream tool's job.
// Third-party renderers for the long tail are a follow-up: because a
// renderer is CODE (not declarative data like a digifab driver), they ride
// the sandboxed-module path + the marketplace's notarised-open trust.
//
// UI-only: no `api`, no `schema`, no migrations. See
// docs/modules/extension-registry.md + the authoring-a-module skill.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-file-preview",
  version: "0.1.0",
  displayName: "File preview",
  description:
    "Read-only previews of model + job files (STL, G-code, SVG, …) wherever a file is shown. Renders, never edits.",
  icon: "eye",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace
  instanceability: "single",

  // Reads files through core-files (foundational, always present); never
  // imports it — the web fetches bytes via the core-files raw endpoint.
  dependencies: ["core-files"],

  // A thin server side ONLY for the installed-renderer store (per
  // workspace). The previews themselves are entirely client-side.
  schema: {
    tablePrefix: "core_file_preview_",
    migrationsDir: "./migrations",
  },
  api: () => import("./api/index.js"),

  intents: [],
  // AI-REACH: none needed — pure rendering plumbing (it turns a stored file into a
  // preview). Nothing here is a thing a person asks about; the FILES themselves
  // are reachable as core-files:file.
  provides: { entityKinds: [] },
  exposes: { events: [], api: [], actions: [] },
});
