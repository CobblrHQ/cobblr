#!/usr/bin/env tsx
// AI-reach lint, ROUTE level: every mutating route a module serves is either
// reachable by the assistant, or says why not, AT THE ROUTE.
//
// The two coarser rules (scripts/lint-ai-reach.ts) already hold: every entity
// kind declares its CRUD routes or justifies the gap, and every module has a
// kind or an action or justifies having neither. What they cannot see is a
// module that has kinds AND actions and still serves a capability covered by
// neither. `POST /locations/reorder` was one: core-locations looked fully
// reachable, and ordering had no door at all. The assistant set `position`
// on twelve racks, the write was silently dropped, and only the user found out
// (2026-08-18). A day's audit then found nine more of the same shape, and the
// only tool for finding them was a script that reported candidates a person
// had to hand-check against each module's actions - a report, which is the
// weakest lever there is.
//
// So the judgement moves to the source, next to the route, where the person
// who wrote it knows the answer. Each mutating route (post/patch/put/delete on
// a router) in a module's api/ must be one of:
//
//   1. a kind's DECLARED CRUD endpoint (createEndpoint / updateEndpoint /
//      deleteEndpoint in the manifest) - already reachable, nothing to write;
//   2. backed by a registered ACTION - annotate `// AI-ACTION: <action-id>`
//      within 6 lines above the route, and that action must exist in the
//      manifest;
//   3. deliberately NOT reachable - annotate `// AI-REACH: <reason>` above the
//      route: an upload, the edge wire, connector credentials, an operator
//      probe, a financial deletion, an unshipped stub. The reason is for the
//      next reader.
//
// Anything else fails. The kernel's plumbing (register/poll/respond/webhooks)
// is recognised by path so nobody annotates the wire forty times.
//
//   cd <repo> && npx tsx scripts/lint-ai-reach-routes.ts
//
// Escape hatch: none beyond the two markers - they ARE the hatch, and they
// leave a sentence behind.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULES = "modules";
const LOOKBACK = 6;
const ACTION_MARK = /AI-ACTION:\s*([a-z0-9-]+:[a-z0-9-]+)/;
const REACH_MARK = /AI-REACH:/;

/** Kernel wire and operator plumbing: never a capability a person asks the
 *  assistant for, so no annotation is demanded. Kept narrow on purpose. */
const PLUMBING =
  /\/(edge|poll|respond|register|webhook|hooks?|callback|heartbeat|probe|healthz|sweep|openapi|_internal)(\/|$)/i;

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

const norm = (p: string): string =>
  ("/" + p.replace(/^\/+/, "")).replace(/\{[^}]+\}/g, ":x").replace(/:[a-zA-Z_]+/g, ":x").replace(/\/+$/, "") || "/";

interface Finding {
  where: string;
  route: string;
  problem: string;
}

const findings: Finding[] = [];
let checked = 0;

for (const mod of readdirSync(MODULES)) {
  const dir = join(MODULES, mod);
  const man = join(dir, "src", "module.ts");
  const api = join(dir, "src", "api");
  if (!existsSync(man) || !existsSync(api)) continue;

  const manSrc = readFileSync(man, "utf8");
  const declared = new Set(
    [...manSrc.matchAll(/(get|create|update|delete)Endpoint:\s*["'`]([^"'`]+)["'`]/g)].map((m) => norm(m[2]!)),
  );
  const actionIds = new Set([...manSrc.matchAll(/id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`]/g)].map((m) => m[1]!));

  // Router mount prefixes, from the module's api/index.ts.
  const idx = join(api, "index.ts");
  const mounts = new Map<string, string>();
  if (existsSync(idx)) {
    for (const m of readFileSync(idx, "utf8").matchAll(/\.use\(\s*(?:["'`]([^"'`]+)["'`]\s*,\s*)?(\w+)\s*\)/g)) {
      mounts.set(m[2]!, m[1] ? norm(m[1]) : "");
    }
  }

  for (const f of walk(api)) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*(\w+)\s*\.\s*(post|patch|put|delete)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/);
      if (!m) continue;
      const [, varName, verb, sub] = m;
      if (!/[Rr]outer$/.test(varName!)) continue;
      // The path may sit on the next line: `router.post(\n  "/x",`
      let path = sub;
      if (path === undefined) {
        const nxt = lines[i + 1]?.match(/^\s*["'`]([^"'`]*)["'`]/);
        path = nxt?.[1];
      }
      if (path === undefined) continue;
      const prefix = mounts.get(varName!);
      const full = prefix === undefined ? norm(path) : norm(prefix + (path === "/" ? "" : path));
      const where = `${f}:${i + 1}`;
      const route = `${verb!.toUpperCase()} ${full}`;
      checked++;

      if (declared.has(full)) continue; // a kind's CRUD endpoint
      if (PLUMBING.test(full)) continue; // the wire, operator plumbing

      const above = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
      const act = above.match(ACTION_MARK);
      if (act) {
        if (!actionIds.has(act[1]!)) {
          findings.push({ where, route, problem: `AI-ACTION names "${act[1]}", which ${mod}'s manifest does not declare` });
        }
        continue;
      }
      if (REACH_MARK.test(above)) continue;
      findings.push({ where, route, problem: "no AI-ACTION / AI-REACH annotation" });
    }
  }
}

if (findings.length > 0) {
  console.error(`✗ ai-reach-routes lint: ${findings.length} mutating route(s) neither reachable by the assistant nor justified.\n`);
  for (const f of findings) console.error(`  ${f.where}\n      ${f.route}\n      ${f.problem}`);
  console.error(`
A route the assistant cannot reach is a capability that exists for a person and
not for Cobb, and nothing fails when that happens - he just says he can't. Say
which it is, at the route, within ${LOOKBACK} lines above it:

    // AI-ACTION: <module>:<action>     it is backed by that registered action
    // AI-REACH: <why not>              it should not have a door (an upload,
                                        the wire, credentials, a financial
                                        deletion, an unshipped stub)

A kind's declared CRUD endpoint needs nothing - the manifest already says so.`);
  process.exit(1);
}

console.log(`✓ ai-reach-routes lint: all ${checked} mutating route(s) are reachable, backed by an action, or justified.`);
