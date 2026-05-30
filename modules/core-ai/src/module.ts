// core-ai — model providers, capabilities, credit tracking.
//
// Workspaces install this when they want Cobblr to use AI on their
// data: classify a brick from a photo, extract structured data from
// an invoice, suggest matches between user entities and catalog
// entries. See docs/design-decisions/core-ai.md.
//
// Stock band. Inert without configured providers. Built-in providers
// (openai, anthropic, ollama) register at module load time; new
// providers slot in by exporting a register() against the platform
// contract.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-ai",
  version: "0.1.0",
  displayName: "AI",
  description:
    "Use AI on your workspace data — classify photos, extract text, summarise, match to catalogs. Configure OpenAI, Anthropic, Ollama, or any provider.",
  icon: "sparkles",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_ai_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-ai.provider.created",
      "core-ai.provider.updated",
      "core-ai.provider.deleted",
      "core-ai.invocation.completed",
      "core-ai.invocation.failed",
      "core-ai.budget.warning",
      "core-ai.budget.exceeded",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
