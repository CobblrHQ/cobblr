#!/usr/bin/env tsx
// A bundle's label or wire template names only fields a reader of that record
// can see: the bundle's own fields and the kind's exposed native ones.
//
// THE BUG THIS PREVENTS. A wire's template is rendered from the record as
// `platform().entities.lookup` hands it over, and that is a PROJECTION: the
// owning module's `exposableFields`, plus the always-readable props, plus the
// record's custom fields. Printer Parts shipped a label reading
// "{{manufacturer}} {{voltage}}" while inventory withheld manufacturer from
// every other reader, so the maker's slot printed blank on every label, and
// nothing said so (#3600, found 2026-09-24 while fixing #3591, where five
// more templates printed placeholders for fields the render could not see).
// A template naming a field the render cannot see is a label with a hole in
// it, decided at authoring time, and a lint is the cheapest place to see it.
//
// THE RULE. For every wire in bundles/*.json with a `template`, or a string
// arg carrying `{{ }}`, each key's first segment must be one of:
//   - a field the bundle itself declares (field_defs anywhere in its
//     manifest) on the wire's source kind or that kind's module kind;
//   - an exposed native field of the module kind (its manifest's
//     exposableFields), or an always-readable prop (IMPLICIT_EXPOSABLE_PROPS,
//     shared with the kernel's projection through the contract);
//   - `event` (the payload block), `metadata` or `_title`.
// A wire whose target is "none" renders with no record, so only `event.*`
// is readable there.
//
// THE BOUNDARY. Bundles only: a person's own wire, authored in the app, is
// judged by the app. A wire targeting a related record through `rel` renders
// that record, whose kind the manifest does not name, so it is skipped and
// counted in the output rather than guessed at. Nothing ships one yet.
//
// Proven red on Printer Parts' template before inventory exposed
// manufacturer; no other shipped template tripped it.
//
//   npx tsx scripts/lint-template-fields-readable.ts   (pnpm lint template-fields-readable)
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IMPLICIT_EXPOSABLE_PROPS } from "../packages/platform-contract/src/entity-metadata.js";

const ROOT = resolve(process.env.COBBLR_LINT_ROOT || new URL("..", import.meta.url).pathname);
const BUNDLES = join(ROOT, "bundles");
const MODULES = join(ROOT, "modules");
const KEY = /\{\{\s*([a-z0-9_.]+)/gi;
const ALWAYS = new Set(["event", "metadata", "_title"]);

interface KindDecl { id: string; primary?: boolean; exposableFields?: string[] }
interface Wire { source_kind: string; action_id: string; template?: string; target?: unknown; args?: Record<string, unknown> }

/** Every module kind's exposed fields, and each module's primary kind, read
 *  from the manifests the way lint:manifests loads them. */
async function moduleKinds(): Promise<{ exposable: Map<string, Set<string>>; primary: Map<string, string> }> {
  const exposable = new Map<string, Set<string>>();
  const primary = new Map<string, string>();
  for (const m of readdirSync(MODULES)) {
    const entry = join(MODULES, m, "src", "module.ts");
    if (!existsSync(entry)) continue;
    const mod = (await import(pathToFileURL(entry).href)) as {
      default?: { name?: string; provides?: { entityKinds?: KindDecl[] } };
    };
    const kinds = mod.default?.provides?.entityKinds ?? [];
    for (const k of kinds) {
      exposable.set(k.id, new Set(k.exposableFields ?? []));
      if (k.primary && mod.default?.name) primary.set(mod.default.name, k.id);
    }
    if (mod.default?.name && !primary.has(mod.default.name) && kinds[0]) primary.set(mod.default.name, kinds[0].id);
  }
  return { exposable, primary };
}

function walk(o: unknown, visit: (rec: Record<string, unknown>) => void): void {
  if (Array.isArray(o)) return o.forEach((x) => walk(x, visit));
  if (!o || typeof o !== "object") return;
  visit(o as Record<string, unknown>);
  for (const v of Object.values(o as Record<string, unknown>)) walk(v, visit);
}

async function main(): Promise<void> {
const { exposable, primary } = await moduleKinds();
const violations: string[] = [];
let checked = 0;
let skipped = 0;

for (const file of readdirSync(BUNDLES).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(BUNDLES, file);
  if (!statSync(path).isFile()) continue;
  const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const manifest = (doc.manifest ?? doc) as Record<string, unknown>;

  // What this bundle declares: fields per kind, and which module each of its
  // instances belongs to.
  const declared = new Map<string, Set<string>>();
  const instanceModule = new Map<string, string>();
  walk(manifest, (rec) => {
    if (typeof rec.entity_kind === "string" && typeof rec.name === "string" && ("type" in rec || "display_label" in rec)) {
      const set = declared.get(rec.entity_kind) ?? new Set<string>();
      set.add(rec.name);
      declared.set(rec.entity_kind, set);
    }
    if (typeof rec.instance_name === "string" && typeof rec.module === "string") instanceModule.set(rec.instance_name, rec.module);
  });

  const wires: Wire[] = [];
  walk(manifest, (rec) => {
    if (typeof rec.action_id === "string" && typeof rec.source_kind === "string") wires.push(rec as unknown as Wire);
  });

  for (const w of wires) {
    const texts: Array<{ where: string; text: string }> = [];
    if (typeof w.template === "string") texts.push({ where: "template", text: w.template });
    for (const [k, v] of Object.entries(w.args ?? {})) if (typeof v === "string" && v.includes("{{")) texts.push({ where: `args.${k}`, text: v });
    if (texts.length === 0) continue;
    if (w.target && typeof w.target === "object") {
      skipped++;
      continue;
    }

    const [prefix, type] = w.source_kind.split(":");
    const moduleKind =
      type === "item" && prefix && instanceModule.has(prefix) ? primary.get(instanceModule.get(prefix)!) ?? w.source_kind : w.source_kind;
    const readable = new Set<string>(ALWAYS);
    if (w.target !== "none") {
      for (const f of IMPLICIT_EXPOSABLE_PROPS) readable.add(f);
      for (const f of exposable.get(moduleKind) ?? []) readable.add(f);
      for (const k of [w.source_kind, moduleKind]) for (const f of declared.get(k) ?? []) readable.add(f);
    } else {
      readable.clear();
      readable.add("event");
    }

    for (const { where, text } of texts) {
      checked++;
      for (const m of text.matchAll(KEY)) {
        const root = m[1]!.split(".")[0]!;
        if (readable.has(root)) continue;
        violations.push(
          `bundles/${file}: ${w.source_kind} → ${w.action_id} ${where} names {{${m[1]}}}, which a reader of ${moduleKind} cannot see` +
            (w.target === "none" ? " (the wire has no record: only event.* is there)" : " (neither a field this bundle declares nor an exposed field of the kind)"),
        );
      }
    }
  }
}

if (violations.length) {
  console.error(`lint:template-fields-readable - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("Declare the field in the bundle, or have the owning module expose it; a template cannot print what its render cannot see.");
  process.exit(1);
}
console.log(`lint:template-fields-readable OK - ${checked} template(s) checked${skipped ? `, ${skipped} on a related record skipped` : ""}`);
}

void main();
