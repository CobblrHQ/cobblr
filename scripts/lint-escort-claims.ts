#!/usr/bin/env tsx
// An escort destination must not claim work an ACTION already does.
//
// take_user_to sends someone to a screen the assistant cannot operate. Every
// destination says why in prose, and that prose reaches the model — so when a
// capability gains an action, a destination still advertising it teaches every
// model to signpost instead of act.
//
// That is not hypothetical. `fields` read "editing or deleting a field touches
// the data under it; adding one is the platform:add-field action" — true when
// only add-field existed. The day editing, removing and grouping got actions,
// nothing updated it, and a local model answered four separate requests with
// "I've taken you to the Fields & forms configuration screen" (measured against
// a real Ollama, 2026-08-25). The prompt said run the action; the tool's own
// description said escort. The tool won.
//
// The rule: if any registered action's id contains a destination's noun, that
// destination must LIST those actions in `covered_by` — which the description
// then renders as "but X, Y do those — run them, don't escort".
//
//   cd <repo> && npx tsx scripts/lint-escort-claims.ts

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { manifestSources } from "./lib/manifest-sources.ts";

const TOOLS = join("packages", "workspace-tools", "src", "tools.ts");
const src = readFileSync(TOOLS, "utf8");

/** Every WORKSPACE-scoped action the platform declares — modules and the kernel.
 *  Workspace scope is the whole point: an entity action ("update this asset's
 *  fields") is about one record and says nothing about a configuration screen.
 *  Without that filter this flagged assets:update-fields against the Fields
 *  screen, which is a different sense of the word entirely. */
const actionIds: string[] = [];
function collect(file: string): void {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)) {
    // The action's own declaration block, far enough to carry its scope.
    const near = text.slice(m.index ?? 0, (m.index ?? 0) + 900);
    const stops = near.indexOf("\n    id:");
    if (/scope:\s*"workspace"/.test(stops > 0 ? near.slice(0, stops) : near)) actionIds.push(m[1]!);
  }
}
for (const mod of readdirSync("modules")) {
  for (const man of manifestSources(join("modules", mod))) collect(man);
}
const kernelActions = join("api", "src", "platform", "platform-actions.ts");
if (existsSync(kernelActions)) collect(kernelActions);

function actionBelongsToDestination(destination: string, action: string): boolean {
  const [owner, operation = ""] = action.split(":");
  // A configuration verb alone does not make another module's calibration an AI-provider action.
  if (destination === "ai-config") {
    return operation.includes("config") && (owner === "core-ai" || owner === "platform" && operation.split("-").includes("ai"));
  }
  const noun = destination.replace(/s$/, "").split("-").pop()!;
  return noun.length >= 4 && operation.includes(noun);
}

/** The destinations, parsed from their literal — id, plus any covered_by. */
const problems: string[] = [];
const block = src.slice(src.indexOf("export const ESCORT_DESTINATIONS"));
const end = block.indexOf("\n];");
for (const entry of block.slice(0, end).split(/\n  \{/).slice(1)) {
  const id = entry.match(/id:\s*"([^"]+)"/)?.[1];
  if (!id) continue;
  const doors = [...new Set(actionIds.filter(action => actionBelongsToDestination(id, action)))];
  if (!doors.length) continue;
  const declared = entry.match(/covered_by:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const missing = doors.filter((d) => !declared.includes(d));
  if (missing.length) {
    problems.push(
      `  ${id} → ${missing.join(", ")}\n      ${missing.length === doors.length ? "no covered_by at all" : "covered_by is missing these"}`,
    );
  }
}

if (problems.length) {
  console.error(
    `✗ escort-claims lint: ${problems.length} destination(s) send people to a screen for work an action already does.\n\n` +
      problems.join("\n") +
      "\n\nAdd them to that destination's `covered_by` (packages/workspace-tools/src/tools.ts) so the\n" +
      "tool tells the model to RUN them, and say in `why` what the screen is still for.\n",
  );
  process.exit(1);
}
console.log("✓ escort-claims lint: no escort destination claims work an action already does");
