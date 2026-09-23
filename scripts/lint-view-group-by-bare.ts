#!/usr/bin/env tsx
// A saved view's group_by is a bare field name, never metadata.<name>: the renderers read the field then fields.metadata, so a prefixed key matches nothing and every row buckets under (none).
//
// THE BUG THIS PREVENTS. A view row carries the module's native columns at the
// top of `fields` and every bundle-added field under `fields.metadata`, and
// the one reading (web/src/lib/view-group-key.ts) looks in both. So a config
// that says `"group_by": "metadata.container_shape"` asks for a field called
// literally "metadata.container_shape", which exists in neither place: the
// Kanban draws one "(none)" column holding everything, and it looks like the
// grouping feature is broken rather than the config. The spice rack's "By
// container" board shipped that way, and the same key was copied into a
// second demo (#3341). The sibling defect, the renderer that read only the
// top level, is #3391.
//
// THE RULE. In every bundle manifest and demo-site view file, a saved view's
// `config.group_by` is a bare field name: the module's own column (`state`,
// `manufacturer`), a bundle field (`container_shape`, `weight_class`), the
// reserved `location`, or `subtitle`. A value containing a dot is refused.
// There is no opt-out: nothing in a view config nests, so a dot is always the
// mistake.
//
// PROVED RED 2026-09-22 against demo-sites/spice-rack/views.json ("By
// container") and demo-sites/lego-collector/views.json ("By theme"), the only
// three occurrences in the repo; green once each dropped the prefix.
//
//   npx tsx scripts/lint-view-group-by-bare.ts   (pnpm run lint view-group-by-bare)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where a saved view can be declared. */
const ROOTS = ["bundles", "demo-sites", "web/src/lib"];

interface Violation {
  file: string;
  line: number;
  what: string;
}

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
    else if (/\.(json|ts)$/.test(name)) yield p;
  }
}

const violations: Violation[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Both spellings: JSON ("group_by": "x") and the TS source (group_by: "x").
      const m = /\bgroup_by"?\s*:\s*"([^"]+)"/.exec(line);
      if (!m) return;
      const key = m[1]!;
      if (!key.includes(".")) return;
      violations.push({
        file,
        line: i + 1,
        what: `group_by "${key}" names no field: drop the prefix and say "${key.split(".").pop()}" (the reading already looks in fields.metadata)`,
      });
    });
  }
}

if (violations.length) {
  console.error(`lint:view-group-by-bare - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A view's group_by is a bare field name; nothing in a view config nests.");
  process.exit(1);
}
console.log("lint:view-group-by-bare OK (every saved view groups by a bare field name)");
