#!/usr/bin/env tsx
// An action that READS a named argument must DECLARE it.
//
// The route lint above this one asks whether a capability has a door at all.
// This one asks whether the door has a handle. core-locations:reorder was
// registered, listed and described in prose, and its `ids` argument existed
// only inside the handler - so an assistant could see the action and had no
// machine-readable way to learn what to pass. It reported that it could not run
// the action, which was true of the surface it had been given (2026-08-19).
//
// Ten more actions were in the same state: adjust-stock read `delta` and
// `reason`, log-measurement read eight args, and not one of them was declared.
// Prose in the description is not a substitute - it is not what a caller reads
// to build the call, and it drifts from the handler with nothing checking.
//
// So: for every action with an invokeHandler, every `args.<name>` the handler
// reads must appear in that action's argsSchema, or the handler must say why
// its args are open:
//
//     // ARGS-OPEN: <reason>        the arg names are not a fixed set
//
// which is the honest answer for the two pass-through shapes here (an inbound
// telemetry write whose args ARE the field names; a device command whose extra
// args are the device's own params).
//
//   cd <repo> && npx tsx scripts/lint-action-args-declared.ts

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const MODULES = "modules";
const OPEN_MARK = /ARGS-OPEN:/;

/** Property reads on an args bag that are never argument names. */
const NOT_AN_ARG = new Set(["length", "map", "filter", "forEach", "slice", "join", "trim", "toString", "then", "catch"]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

/** The args a handler body reads, by name. Covers the three shapes in this
 *  repo: `ctx.args.x`, a local alias (`const args = ctx.args as T` then
 *  `args.x`), and `readListArg(ctx.args, "x")`. */
function argsRead(body: string): Set<string> {
  const names = new Set<string>();
  for (const m of body.matchAll(/\bargs\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) names.add(m[1]!);
  for (const m of body.matchAll(/readListArg\(\s*(?:ctx\.)?args\s*,\s*["'`]([^"'`]+)["'`]/g)) names.add(m[1]!);
  for (const m of body.matchAll(/\bargs\?\.\[?["'`]?([a-zA-Z_][a-zA-Z0-9_]*)/g)) names.add(m[1]!);
  for (const n of NOT_AN_ARG) names.delete(n);
  return names;
}

/** Handler bodies by registered key. A body runs to the next registerHandler
 *  (or end of file), which is wider than the function but only ever ADDS
 *  candidate names within the same module - and every extra name it could pick
 *  up is itself an arg some sibling handler reads. */
function handlerBodies(files: string[]): Map<string, { body: string; where: string }> {
  const out = new Map<string, { body: string; where: string }>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const starts = [...src.matchAll(/registerHandler\(\s*["'`]([^"'`]+)["'`]/g)];
    for (const [i, m] of starts.entries()) {
      const from = m.index!;
      const to = i + 1 < starts.length ? starts[i + 1]!.index! : src.length;
      const line = src.slice(0, from).split("\n").length;
      out.set(m[1]!, { body: src.slice(from, to), where: `${f}:${line}` });
    }
  }
  return out;
}

/** Each action literal in a manifest, sliced from its `id:` to the next one. */
function manifestActions(src: string): Array<{ id: string; handler: string | null; declared: Set<string> }> {
  const out: Array<{ id: string; handler: string | null; declared: Set<string> }> = [];
  const ids = [...src.matchAll(/^\s*id:\s*["'`]([a-z0-9-]+:[a-z0-9-]+)["'`],/gm)];
  for (const [i, m] of ids.entries()) {
    const block = src.slice(m.index!, i + 1 < ids.length ? ids[i + 1]!.index! : src.length);
    const handler = block.match(/invokeHandler:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
    // Union of EVERY argsSchema in the action, not just the first: a block
    // that carried two (a real duplicate) once hid the second from this check.
    const declared = new Set<string>();
    for (const schema of block.matchAll(/argsSchema:\s*\{([\s\S]*?)\n\s{6,8}\},/g)) {
      for (const x of schema[1]!.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\{/gm)) declared.add(x[1]!);
    }
    out.push({ id: m[1]!, handler, declared });
  }
  return out;
}

interface Finding {
  action: string;
  where: string;
  missing: string[];
}

const findings: Finding[] = [];
let checked = 0;

for (const mod of readdirSync(MODULES)) {
  const man = join(MODULES, mod, "src", "module.ts");
  const api = join(MODULES, mod, "src");
  if (!existsSync(man) || !existsSync(api)) continue;
  const handlers = handlerBodies(walk(api));

  for (const a of manifestActions(readFileSync(man, "utf8"))) {
    if (!a.handler) continue;
    const h = handlers.get(a.handler);
    if (!h) continue; // route-only, or registered elsewhere
    if (OPEN_MARK.test(h.body)) continue;
    checked++;
    const missing = [...argsRead(h.body)].filter((n) => !a.declared.has(n)).sort();
    if (missing.length) findings.push({ action: a.id, where: h.where, missing });
  }
}

if (findings.length > 0) {
  console.error(
    `✗ action-args lint: ${findings.length} action(s) read arguments nobody can discover.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.action}\n      ${f.where}\n      reads but does not declare: ${f.missing.join(", ")}`);
  }
  console.error(`
An action listed without its arguments cannot be invoked without guessing, and a
caller that is not a person will say so and stop. Declare them in the manifest:

    argsSchema: {
      <name>: { label: "what it is, in a sentence", type: "text" },
    },

types are text | number | boolean | list. Read a list arg with
readListArg(ctx.args, "<name>") so an array and a comma-separated string mean
the same thing.

If the names genuinely are not a fixed set (a pass-through shape), say so in the
handler:

    // ARGS-OPEN: <why the names are open>`);
  process.exit(1);
}

console.log(`✓ action-args lint: all ${checked} handler-backed action(s) declare the arguments they read.`);
