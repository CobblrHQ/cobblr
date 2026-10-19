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
//   AI-REACH: action[ <id>]  — reached via a declared action (invoke_action);
//   AI-ACTION: <id>             says the same, in lint-ai-reach-routes' grammar
//   AI-TOOL: <tool>          — reached by a workspace tool of its own (checked
//                              against the registry by lint-ai-reach-routes)
//   AI-REACH: crud           — this is a kind's create/update/delete endpoint
//                              (governed by lint-ai-reach at the kind level)
//   AI-REACH: exempt <why>   — deliberately NOT AI-reachable, with a reason:
//                              webhook receiver, health probe, internal/boot,
//                              auth callback, media stream, code minting, ...
//
// No baseline: every unclassified route it grandfathered was classified by
// #7236, so a mutating route with no marker fails outright, and there is no
// list to add one to.
//
//   cd <repo> && npx tsx scripts/lint-ai-coverage.ts
//
// Scope: modules/*/src/api/ (where module capabilities land). Platform routes
// (api/src/routes) are out of scope for now — noted for a follow-up.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiDirs } from "./lib/manifest-sources.ts";

const ROOT = process.env.COBBLR_LINT_ROOT || ".";
const MODULES_DIR = join(ROOT, "modules");
const LOOKBACK = 8;
// A route call on any `*Router` variable (the repo convention — codesRouter,
// partsRouter, …). Whitespace/newlines between "(" and the path are allowed so
// the common multi-line `router.post(\n  "/x",` form is matched.
const ROUTE_RE = /(\w*[Rr]outer)\.(post|put|patch|delete)\(\s*["'`]([^"'`]*)["'`]/g;
// AI-ACTION: <id> is the same claim as AI-REACH: action <id>, in the grammar
// lint-ai-reach-routes reads (and checks against the manifest), so a route
// that says it once in either form is classified by both lints.
const CATEGORY_RE = /AI-REACH:\s*(action|crud|exempt)\b|AI-TOOL:\s*[a-z0-9_]+|AI-ACTION:\s*[a-z0-9-]+:[a-z0-9-]+/i;

// An exempt has to say WHY, as a reason the owner would agree with: a security
// or safety boundary, or the door that does reach it. "Not needed" is the gap
// this lint exists to close, not a reason (#6947).
const EXEMPT_RE = /AI-REACH:\s*exempt\b\s*(?:internal\b)?[\s:—–-]*([^\n]*(?:\n\s*\/\/(?!\s*(?:UI-REACH|AI-|AUTH|TODO))[^\n]*)*)/i;
const DISMISSAL_RE = /\b(not needed|no need|unneeded|not necessary|not useful|nobody (?:needs|asks)|not worth)\b/i;
const MIN_REASON_WORDS = 4;

interface Finding {
  file: string;
  method: string;
  path: string;
  line: number;
}

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
const badReasons: Array<Finding & { why: string }> = [];
for (const m of readdirSync(MODULES_DIR)) {
  const dirs = apiDirs(join(MODULES_DIR, m)).filter((d) => statSync(d).isDirectory());
  if (dirs.length === 0) continue;
  const files: string[] = [];
  for (const apiDir of dirs) walk(apiDir, files);
  for (const file of files.sort()) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (const match of src.matchAll(ROUTE_RE)) {
      const method = match[2]!.toLowerCase();
      const routePath = match[3]!;
      const line = src.slice(0, match.index).split("\n").length; // 1-based
      // Marker lookback: the LOOKBACK lines immediately above the route line.
      const context = lines.slice(Math.max(0, line - 1 - LOOKBACK), line).join("\n");
      if (CATEGORY_RE.test(context)) {
        const ex = context.match(EXEMPT_RE);
        if (ex && !/AI-ACTION:|AI-TOOL:|AI-REACH:\s*(action|crud)\b/i.test(context)) {
          const reason = ex[1]!.replace(/\/\//g, " ").replace(/\s+/g, " ").trim();
          const words = reason.split(" ").filter((w) => /[a-z]/i.test(w)).length;
          if (words < MIN_REASON_WORDS) badReasons.push({ file, method, path: routePath, line, why: "gives no reason" });
          else if (DISMISSAL_RE.test(reason)) badReasons.push({ file, method, path: routePath, line, why: `says "${reason.match(DISMISSAL_RE)![0]}", which is not a reason` });
        }
        continue; // classified — reachable or justified
      }
      findings.push({ file, method, path: routePath, line });
    }
  }
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

console.log(`ai-coverage lint: ${findings.length} unclassified mutating route(s)`);
if (badReasons.length > 0) {
  console.error(`\n✗ AI-REACH: exempt without a reason the owner would agree with:\n`);
  for (const v of badReasons) console.error(`  ${v.file}:${v.line} — ${v.method.toUpperCase()} ${v.path}: ${v.why}`);
  console.error(`\nSay what boundary keeps the assistant out (a secret, a person's own consent or
Confirm, money, the device wire, a file stream) or which action/tool reaches the
same thing. If none applies, the route needs an action, not an exemption.`);
  process.exit(1);
}
if (findings.length > 0) {
  console.error(`\n✗ Mutating route(s) with no AI-reachability classification:\n`);
  for (const v of findings) console.error(`  ${v.file}:${v.line} — ${v.method.toUpperCase()} ${v.path}`);
  console.error(`\nA new module operation must be reachable by the AI (Ask Cobb / MCP) or say
why not. Add a comment within ${LOOKBACK} lines above the route:
  AI-REACH: action <id>   — expose it as an action (entity or workspace) so Cobb
                            invokes it through invoke_action (see labels:set-code
                            in modules/labels for a workspace action);
  AI-REACH: crud          — it's a kind's create/update/delete endpoint;
  AI-REACH: exempt <why>  — deliberately not AI-reachable (webhook, health,
                            internal, auth, media, minting), with a reason.
There is no baseline to add it to. See docs/architecture/wires-and-bundles.md (actions, and the
workspace scope) and docs/modules/mcp-server.md (AI reachability).`);
  process.exit(1);
}
console.log("✓ ai-coverage lint: every mutating module route is AI-reachable or justified.");
