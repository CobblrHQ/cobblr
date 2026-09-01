#!/usr/bin/env tsx
// A tool's description is sent to the model on EVERY turn, for every tool.
//
// Measured 2026-08-27: the 23 workspace tools cost ~17,700 chars (about 4,400
// input tokens) per turn before the user has said anything, and one of them
// (take_user_to) was 1,570 chars, mostly rationale that belonged in a code
// comment. A description grows one helpful sentence at a time and nothing
// pushes back, so this does: a cap per description and a budget for the set.
// The model needs the sentence that lets it CHOOSE the tool and CALL it; the
// why goes in a comment above it, where the next engineer reads it for free.
//
// Runtime import on purpose: take_user_to's description is built from
// ESCORT_DESTINATIONS at load time, so a text scan would under-count it.
//
//   npx tsx scripts/lint-tool-descriptions.ts
import { WORKSPACE_TOOLS, jsonSchemaOf } from "../packages/workspace-tools/src/index.js";

const MAX_DESCRIPTION_CHARS = 1000;
const MAX_TOTAL_SCHEMA_CHARS = 17_000;

let bad = 0;
let total = 0;
for (const t of WORKSPACE_TOOLS) {
  const schema = JSON.stringify({ name: t.name, description: t.description, parameters: jsonSchemaOf(t.params) });
  total += schema.length;
  if (t.description.length > MAX_DESCRIPTION_CHARS) {
    bad += 1;
    console.error(
      `  ✗ ${t.name}: description is ${t.description.length} chars (cap ${MAX_DESCRIPTION_CHARS}). Keep the sentence a model needs to choose and call it; move the why into a comment above it.`,
    );
  }
}
if (total > MAX_TOTAL_SCHEMA_CHARS) {
  bad += 1;
  console.error(`  ✗ the ${WORKSPACE_TOOLS.length} tool schemas total ${total} chars (budget ${MAX_TOTAL_SCHEMA_CHARS}); that is sent on every turn.`);
}
if (bad) {
  console.error(`lint:tool-descriptions FAILED (${bad})`);
  process.exit(1);
}
console.log(`✓ tool-descriptions: ${WORKSPACE_TOOLS.length} tools, ${total} schema chars, longest description ${Math.max(...WORKSPACE_TOOLS.map((t) => t.description.length))}`);
