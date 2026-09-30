// core-ai — model providers, capabilities, credit tracking.
//
// Workspaces install this when they want Cobblr to use AI on their
// data: classify a brick from a photo, extract structured data from
// an invoice, suggest matches between user entities and catalog
// entries. See docs/modules/core-ai.md.
//
// Stock band. Inert without configured providers. Built-in providers
// (openai, anthropic, ollama) register at module load time; new
// providers slot in by exporting a register() against the platform
// contract.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-ai",
  version: "0.40.18",
  displayName: "AI",
  description:
    "Let AI help with your things: recognise photos, read text, sum up and match items to catalogs, using the provider you choose.",
  icon: "sparkles",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_ai_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  // AI-REACH: none needed — this module IS the assistant (and the provider
  // plumbing behind it). Giving it a door would be Cobb calling Cobb; its
  // settings are an operator surface under Configuration → AI.

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-ai.provider.created",
      "core-ai.provider.updated",
      "core-ai.provider.deleted",
      "core-ai.basic.created",
      "core-ai.basic.updated",
      "core-ai.basic.deleted",
    ],
    actions: [],
  },

  subscribes: [],
});
