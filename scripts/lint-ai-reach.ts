#!/usr/bin/env tsx
// AI-reach lint — every entity kind must be reachable by the AI tool surfaces
// (Ask Cobb + the MCP server, via @cobblr/workspace-tools), or say why not.
//
// The gap this closes (found by the 2026-07-10 reach audit, fixed in #843):
// modules shipped kinds with REST CRUD routes but never declared
// createEndpoint / updateEndpoint / deleteEndpoint in the manifest — and the
// tool registry deliberately never guesses routes, so those kinds were
// silently unwritable to agents. Nothing failed; capability just quietly
// didn't exist. That's the worst kind of gap: invisible until a user asks
// Cobb to do something and gets "can't be created this way".
//
// TWO rules:
//   1. a declared kind must be writable (or justify the omission) — below;
//   2. a module that declares NO kinds and NO actions must name its door, or
//      say why it needs none. Rule 1 cannot see rule 2's failure: it walks the
//      kinds a module declares, so declaring none passes it trivially. That is
//      how ten user-facing modules ended up wholly unreachable to Ask Cobb and
//      the MCP server with nothing failing (the 2026-08-14 reach audit —
//      docs/design-decisions/ai-reach-audit.md).
//
// The rule: a `provides.entityKinds[]` entry missing any of the three CRUD
// endpoint declarations must carry a comment containing "AI-CRUD:" within
// the 8 lines above its `id:` line, saying which verbs are absent and why
// (e.g. import-owned, action-written, nested-only). New kinds either declare
// their write routes or justify the omission at the declaration site —
// exactly the lint-action-predicates pattern.
//
//   cd <repo> && npx tsx scripts/lint-ai-reach.ts
//
// Local + CI, free. Imports the real manifests (same as lint-manifests), so
// there's no regex-parsing of nested manifest structure — only the comment
// lookup reads source text.

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULES_DIR = "modules";
const MARKER = "AI-CRUD:";
/** Rule 2's marker: how this module is reached at all, or why it needs no door. */
const REACH_MARKER = "AI-REACH:";
const LOOKBACK = 8;

interface KindDecl {
  id?: string;
  createEndpoint?: string;
  updateEndpoint?: string;
  deleteEndpoint?: string;
}

async function main(): Promise<void> {
  const findings: string[] = [];
  const doorless: string[] = [];

  for (const m of readdirSync(MODULES_DIR)) {
    const dir = join(MODULES_DIR, m);
    if (m.startsWith(".") || !statSync(dir).isDirectory() || !existsSync(join(dir, "package.json"))) continue;
    const entry = resolve(dir, "src", "module.ts");
    if (!existsSync(entry)) continue;

    let kinds: KindDecl[];
    let actionCount: number;
    try {
      const mod = (await import(pathToFileURL(entry).href)) as {
        default?: {
          provides?: { entityKinds?: KindDecl[] };
          exposes?: { actions?: unknown[] };
        };
      };
      kinds = mod.default?.provides?.entityKinds ?? [];
      actionCount = (mod.default?.exposes?.actions ?? []).length;
    } catch {
      continue; // invalid manifest — lint-manifests owns that failure
    }

    const src = readFileSync(join(dir, "src", "module.ts"), "utf8");
    const lines = src.split("\n");

    // RULE 2 — a module with NO door at all must say so.
    //
    // Rule 1 (below) walks the kinds a module DECLARES, so a module that
    // declares none passes it trivially: there is nothing to walk. The
    // 2026-08-14 reach audit found ten user-facing modules in exactly that
    // state — activity log, notifications, maintenance, views, integrations,
    // apps, templates, units, recurrence, import — every screen of them
    // invisible to Ask Cobb and the MCP server, silently, with nothing failing.
    //
    // The shape of the miss: a queue, a feed, a log and a config page are not
    // records, so "declare your entity kinds" never applied to any of them.
    // A module with neither kinds nor actions therefore has to name its door —
    // a tool in @cobblr/workspace-tools, another module's action — or say why
    // it needs none (plumbing nobody asks about). Answered once, at authoring
    // time, by the person who knows the answer.
    if (kinds.length === 0 && actionCount === 0 && !src.includes(REACH_MARKER)) {
      doorless.push(`  ${join(dir, "src", "module.ts")} — ${m}`);
    }

    for (const k of kinds) {
      if (!k.id) continue;
      const missing = [
        !k.createEndpoint && "create",
        !k.updateEndpoint && "update",
        !k.deleteEndpoint && "delete",
      ].filter(Boolean) as string[];
      if (missing.length === 0) continue;

      // Locate the kind's `id: "<kind-id>"` line and check the lookback
      // window for the justification marker.
      const idLine = lines.findIndex((l) => l.includes(`id: "${k.id}"`) || l.includes(`id: '${k.id}'`));
      const context =
        idLine >= 0 ? lines.slice(Math.max(0, idLine - LOOKBACK), idLine + 1).join("\n") : "";
      if (context.includes(MARKER)) continue;

      findings.push(`  ${join(dir, "src", "module.ts")}${idLine >= 0 ? `:${idLine + 1}` : ""} — ${k.id} missing ${missing.join("/")}`);
    }
  }

  if (doorless.length > 0) {
    console.error(`✗ ai-reach lint: ${doorless.length} module(s) with no AI door and no explanation.\n`);
    console.error(doorless.join("\n"));
    console.error(`\nA module with no entity kinds and no actions cannot be reached by Ask Cobb or
the MCP server at all: list_records has nothing to list, invoke_action has
nothing to invoke. That is correct for plumbing (a job queue, a spec generator)
and a silent hole for anything a person can see on a screen — it is how ten
user-facing modules ended up unreachable without a single failure (the
2026-08-14 reach audit).

Say which one it is: add a comment containing "${REACH_MARKER}" to the module's
manifest, naming the tool or action that reaches its surface, or why nothing
needs to. See docs/design-decisions/ai-reach-audit.md.`);
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(`✗ ai-reach lint: ${findings.length} entity kind(s) not AI-reachable and not justified.\n`);
    console.error(findings.join("\n"));
    console.error(`\nA kind with no createEndpoint/updateEndpoint/deleteEndpoint is silently
unwritable to the AI surfaces (Ask Cobb, MCP) — the tool registry never guesses
routes. Either declare the endpoints on the kind (module-relative, {id}
placeholder — see any CRUD-declared kind for the shape) or, if the omission is
deliberate (import-owned, action-written, nested-only, upload-created), add a
comment containing "${MARKER}" within ${LOOKBACK} lines above the kind's id,
naming the absent verbs and why. See docs/modules/mcp-server.md (Operate).`);
    process.exit(1);
  }
  console.log(
    "✓ ai-reach lint: every module has an AI door or says why not, and every entity kind is reachable or justified.",
  );
}

main().catch((err) => {
  console.error("ai-reach lint crashed:", err);
  process.exit(1);
});
