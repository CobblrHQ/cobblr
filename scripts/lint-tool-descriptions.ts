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
// Raised from 17,000 to 17,300 on 2026-09-28 for things_of_person (300 chars,
// the smallest description that lets a model pick it), a capability the owner
// asked for (#3787: "what does Alex own"). The set had 23 chars of room, so any
// new tool needed this; the next one should first make room by tightening.
const MAX_TOTAL_SCHEMA_CHARS = 17_300;
// Tools sent only when the workspace can use them (`sentWhen`) are not on
// every turn, so they have their own, smaller budget instead of taking room
// from the set that is. The service tools (list_services, invoke_service,
// get_service_job, #4034) go out only where a service capability is
// connected. A conditional tool still pays when it is sent, so it is capped.
// Station review adds 938 characters only for a person with a station. Its
// three reads cover setup, paged history and a whole session for Cobb and MCP.
const MAX_CONDITIONAL_SCHEMA_CHARS = 2_350;
// A module's own tools (`module`) go out only where that module is on, so they
// are not the kernel's every-turn cost and do not crowd it: each module's set
// has a cap of its own instead. Before this, the every-turn set held the laser
// floor's reads for a workspace with no laser, and sat 51 chars under its
// budget, so the next module tool anywhere turned an unrelated PR red.
const MAX_MODULE_SCHEMA_CHARS = 4_000;

let bad = 0;
let total = 0;
let conditional = 0;
const perModule = new Map<string, number>();
const everyTurn: Array<{ name: string; chars: number }> = [];
for (const t of WORKSPACE_TOOLS) {
  const schema = JSON.stringify({ name: t.name, description: t.description, parameters: jsonSchemaOf(t.params) });
  if (t.module) perModule.set(t.module, (perModule.get(t.module) ?? 0) + schema.length);
  else if (t.sentWhen) conditional += schema.length;
  else {
    total += schema.length;
    everyTurn.push({ name: t.name, chars: schema.length });
  }
  if (t.description.length > MAX_DESCRIPTION_CHARS) {
    bad += 1;
    console.error(
      `  ✗ ${t.name}: description is ${t.description.length} chars (cap ${MAX_DESCRIPTION_CHARS}). Keep the sentence a model needs to choose and call it; move the why into a comment above it.`,
    );
  }
}
if (total > MAX_TOTAL_SCHEMA_CHARS) {
  bad += 1;
  console.error(`  ✗ the tool schemas sent on every turn total ${total} chars (budget ${MAX_TOTAL_SCHEMA_CHARS}).`);
  console.error(`    The biggest, where room is to be found (or give a module's tool its module: so it is sent only where the module is on):`);
  for (const t of [...everyTurn].sort((a, b) => b.chars - a.chars).slice(0, 5)) console.error(`      ${String(t.chars).padStart(6)}  ${t.name}`);
}
for (const [mod, chars] of perModule) {
  if (chars > MAX_MODULE_SCHEMA_CHARS) {
    bad += 1;
    console.error(`  ✗ ${mod}'s own tools total ${chars} chars (budget ${MAX_MODULE_SCHEMA_CHARS} per module).`);
  }
}
if (conditional > MAX_CONDITIONAL_SCHEMA_CHARS) {
  bad += 1;
  console.error(`  ✗ the tool schemas sent only when they apply total ${conditional} chars (budget ${MAX_CONDITIONAL_SCHEMA_CHARS}).`);
}
if (bad) {
  console.error(`lint:tool-descriptions FAILED (${bad})`);
  process.exit(1);
}
console.log(`✓ tool-descriptions: ${WORKSPACE_TOOLS.length} tools, ${total} schema chars every turn + ${conditional} when they apply + ${[...perModule].map(([m, c]) => `${c} for ${m}`).join(", ")} where on, longest description ${Math.max(...WORKSPACE_TOOLS.map((t) => t.description.length))}`);
