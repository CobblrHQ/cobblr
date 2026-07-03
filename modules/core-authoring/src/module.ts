// core-authoring — the AI app builder (Phase 1: the create-bundle task).
//
// A non-dev describes what they want ("when a part runs low, print a
// reorder label") and gets a working bundle (custom fields + wires)
// without writing JSON. The module is a PROMPT COMPILER: it assembles
// the minimal sufficient context (the relevant entity-kind schemas + the
// actions those kinds can be wired to + the output contract) and the
// user's intent into one prompt whose answer is a schema-validated
// bundle manifest.
//
// Phase 1 is zero-inference: copy-paste mode. The site builds the prompt;
// the user runs it in their own ChatGPT/Claude and pastes the manifest
// back; the kernel's EXISTING bundle validation (/bundles/validate) grades
// it; valid candidates apply via the EXISTING /bundles/install. We never
// apply a broken artifact — "kernel owns correctness."
//
// No entity kinds (like core-apps). It persists DRAFTS, which double as
// the eval corpus. See docs/modules/ai-bundle-builder.md and the
// strategy in CobblrHQ/business-models/docs/{04,06}.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-authoring",
  version: "0.4.0",
  displayName: "App Builder",
  description:
    "Describe what you want; the builder compiles a prompt whose answer is a working bundle (custom fields + wires) you review and apply. The kernel validates every candidate before anything is applied.",
  icon: "wand-2",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace
  headerAction: { icon: "wand-2", label: "Build", route: "/build" },

  schema: {
    tablePrefix: "core_authoring_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // Soft-depends on core-ai for hosted mode (Phase 2) only — Phase 1 is
  // copy-paste, no inference. Declared as no hard dependency so the
  // builder works on a workspace without core-ai.
  dependencies: [],

  provides: { entityKinds: [] },

  exposes: {
    events: ["core-authoring.draft.created", "core-authoring.draft.applied"],
    api: [],
    actions: [],
  },

  subscribes: [],
});
