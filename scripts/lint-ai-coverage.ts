#!/usr/bin/env tsx
// AI-coverage lint — every MUTATING route on a module surface must be reachable
// by the AI (Ask Cobb + the MCP, via @cobblr/workspace-tools), or say why not.
//
// This is the standing guardrail behind "the AI has to be able to do anything
// for the user." lint-ai-reach covers entity KINDS (create/update/delete a
// record). This covers everything else a module can DO: the config/admin/action
// routes that aren't a kind's CRUD — rename a code prefix, change a default,
// seed a group, run a job. Those become AI-reachable by being declared as an
// ACTION (entity or workspace) that Cobb invokes through invoke_action; a new
// mutating route that is neither a kind's CRUD nor an action is silently
// unreachable — the exact invisible gap that motivated the workspace-action work.
//
// The rule: every `<name>Router.(post|put|patch|delete)(...)` under a module's
// src/api/ must carry an "AI-REACH:" classification within the LOOKBACK lines
// above it — one of:
//   AI-REACH: action[ <id>]  — reached via a declared action (invoke_action)
//   AI-REACH: crud           — this is a kind's create/update/delete endpoint
//                              (governed by lint-ai-reach at the kind level)
//   AI-REACH: exempt <why>   — deliberately NOT AI-reachable, with a reason:
//                              webhook receiver, health probe, internal/boot,
//                              auth callback, media stream, code minting, ...
//
// Baseline: scripts/ai-coverage-baseline.json freezes the KNOWN existing
// unclassified routes (predate this rule). The lint is GREEN today and FAILS on
// any NEW unclassified mutating route. Shrink the baseline, never grow it — the
// way to shrink it is to add an AI-REACH marker to a baselined route.
//
//   cd <repo> && npx tsx scripts/lint-ai-coverage.ts
//   cd <repo> && npx tsx scripts/lint-ai-coverage.ts --write-baseline   # regenerate
//
// Scope: modules/*/src/api/ (where module capabilities land). Platform routes
// (api/src/routes) are out of scope for now — noted for a follow-up.

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "modules";
const BASELINE_PATH = "scripts/ai-coverage-baseline.json";
const LOOKBACK = 8;
// A route call on any `*Router` variable (the repo convention — codesRouter,
// partsRouter, …). Whitespace/newlines between "(" and the path are allowed so
// the common multi-line `router.post(\n  "/x",` form is matched.
const ROUTE_RE = /(\w*[Rr]outer)\.(post|put|patch|delete)\(\s*["'`]([^"'`]*)["'`]/g;
const CATEGORY_RE = /AI-REACH:\s*(action|crud|exempt)\b/i;

interface Finding {
  file: string;
  method: string;
  path: string;
  line: number;
}
type BaselineEntry = Omit<Finding, "line">;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "tests") continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
}

const findings: Finding[] = [];
for (const m of readdirSync(MODULES_DIR)) {
  const apiDir = join(MODULES_DIR, m, "src", "api");
  if (!existsSync(apiDir) || !statSync(apiDir).isDirectory()) continue;
  const files: string[] = [];
  walk(apiDir, files);
  for (const file of files.sort()) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (const match of src.matchAll(ROUTE_RE)) {
      const method = match[2]!.toLowerCase();
      const routePath = match[3]!;
      const line = src.slice(0, match.index).split("\n").length; // 1-based
      // Marker lookback: the LOOKBACK lines immediately above the route line.
      const context = lines.slice(Math.max(0, line - 1 - LOOKBACK), line).join("\n");
      if (CATEGORY_RE.test(context)) continue; // classified — reachable or justified
      findings.push({ file, method, path: routePath, line });
    }
  }
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const key = (v: BaselineEntry) => `${v.file}::${v.method}::${v.path}`;

if (process.argv.includes("--write-baseline")) {
  const entries: BaselineEntry[] = findings.map((f) => ({ file: f.file, method: f.method, path: f.path }));
  writeFileSync(BASELINE_PATH, JSON.stringify(entries, null, 2) + "\n");
  console.log(`wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to ${BASELINE_PATH}`);
  process.exit(0);
}

const baseline: BaselineEntry[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineEntry[])
  : [];
const baselined = new Set(baseline.map(key));
const fresh = findings.filter((v) => !baselined.has(key(v)));
const stale = baseline.filter((b) => !findings.some((v) => key(v) === key(b)));

console.log(
  `ai-coverage lint: ${findings.length} unclassified mutating route(s), ${findings.length - fresh.length} baselined, ${fresh.length} NEW`,
);
if (stale.length > 0) {
  console.log(
    `  (${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} stale — route gone or now classified; prune with --write-baseline)`,
  );
}
if (fresh.length > 0) {
  console.error(`\n✗ NEW mutating route(s) with no AI-reachability classification:\n`);
  for (const v of fresh) console.error(`  ${v.file}:${v.line} — ${v.method.toUpperCase()} ${v.path}`);
  console.error(`\nA new module operation must be reachable by the AI (Ask Cobb / MCP) or say
why not. Add a comment within ${LOOKBACK} lines above the route:
  AI-REACH: action <id>   — expose it as an action (entity or workspace) so Cobb
                            invokes it through invoke_action (see labels:set-code
                            in modules/labels for a workspace action);
  AI-REACH: crud          — it's a kind's create/update/delete endpoint;
  AI-REACH: exempt <why>  — deliberately not AI-reachable (webhook, health,
                            internal, auth, media, minting), with a reason.
Do NOT add it to the baseline — the baseline only grandfathers routes that
predate this rule. See docs/architecture/wires-and-bundles.md (actions, and the
workspace scope) and docs/modules/mcp-server.md (AI reachability).`);
  process.exit(1);
}
console.log("✓ ai-coverage lint: every mutating module route is AI-reachable or justified.");
