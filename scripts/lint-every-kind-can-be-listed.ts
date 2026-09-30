#!/usr/bin/env tsx
// Every entity kind a module declares can be listed: it registers a list
// resolver, and a module with named collections registers one for their items.
//
// THE BUG THIS PREVENTS. The fundamentals audit of search and assistant reach
// (#4115, 2026-09-29): `digifab:job` and `sales:order_item` had a lookup but
// no list resolver, and sales registered none for its named collections. So
// search skipped them, a view over them was empty, and an assistant asked
// "how many print jobs" was told none, with no error anywhere: a kind with no
// list resolver reads exactly like a kind with no records.
//
// THE RULE. For every `provides.entityKinds[]` entry in a module's manifest,
// some source file under modules/ or api/src calls
// `registerListResolver("<kind id>"` with the id as a literal. A kind that is
// genuinely not a list (none today) says why with a comment containing
// `NO-LIST:` within the 8 lines above its `id:` line. A module whose manifest
// says `instanceability: "multi"` also calls
// `registerInstanceListResolver("<module name>"`, or a named collection's
// `<name>:item` lists nothing.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A first regex over the
// manifests' `id:` lines also caught every action id (`inventory:use-one`),
// which are not kinds; the manifests are imported instead (as lint-ai-reach
// and lint-manifests do), so only declared kinds are judged. The resolver is
// matched by its literal id: a resolver registered through a computed string
// would read as missing, and none is today.
//
// PROVE IT RED before you trust it green: it failed on digifab:job,
// sales:order_item and the sales module before their resolvers were added.
//
//   npx tsx scripts/lint-every-kind-can-be-listed.ts   (pnpm lint every-kind-can-be-listed)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULES_DIR = "modules";
/** Where a list resolver may be registered: a module's source, or the kernel. */
const ROOTS = ["modules", "api/src"];
const MARKER = "NO-LIST:";
const LOOKBACK = 8;

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function main(): Promise<void> {
  const source = ROOTS.flatMap((r) => [...walk(r)]).map((f) => readFileSync(f, "utf8")).join("\n");
  const registers = (fn: string, id: string) => new RegExp(`${fn}\\(\\s*["'\`]${esc(id)}["'\`]`).test(source);
  const out: string[] = [];

  for (const m of readdirSync(MODULES_DIR).sort()) {
    const dir = join(MODULES_DIR, m);
    if (m.startsWith(".") || !statSync(dir).isDirectory()) continue;
    const entry = resolve(dir, "src", "module.ts");
    if (!existsSync(entry)) continue;
    let manifest: { name?: string; instanceability?: string; provides?: { entityKinds?: Array<{ id?: string }> } } | undefined;
    try {
      manifest = ((await import(pathToFileURL(entry).href)) as { default?: typeof manifest }).default;
    } catch {
      continue; // an invalid manifest is lint-manifests' failure
    }
    if (!manifest) continue;
    const lines = readFileSync(entry, "utf8").split("\n");
    const file = join(dir, "src", "module.ts");

    for (const k of manifest.provides?.entityKinds ?? []) {
      if (!k.id || registers("registerListResolver", k.id)) continue;
      const at = lines.findIndex((l) => new RegExp(`\\bid:\\s*["'\`]${esc(k.id!)}["'\`]`).test(l));
      const above = lines.slice(Math.max(0, at - LOOKBACK), at + 1).join("\n");
      if (at >= 0 && above.includes(MARKER)) continue;
      out.push(`${file}:${at + 1}  ${k.id} has no list resolver: search, views and an assistant see none of its records`);
    }

    const name = manifest.name ?? m;
    if (manifest.instanceability === "multi" && !registers("registerInstanceListResolver", name)) {
      const at = lines.findIndex((l) => /instanceability:/.test(l));
      out.push(`${file}:${at + 1}  ${name} has named collections but no registerInstanceListResolver("${name}"): a collection's items list as none`);
    }
  }

  if (out.length) {
    console.error(`lint:every-kind-can-be-listed - ${out.length} violation(s):`);
    for (const v of out) console.error(`  ${v}`);
    console.error(
      `A kind with no list resolver reads exactly like a kind with no records. Register one\n` +
        `(platform().entities.registerListResolver("<kind>", ...)), or say why the kind is not a\n` +
        `list with a \`${MARKER} <why>\` comment above its id.`,
    );
    process.exit(1);
  }
  console.log("lint:every-kind-can-be-listed OK");
}

void main();
