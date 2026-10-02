#!/usr/bin/env tsx
// A native field that declares a fill role (acquired-on, acquired-for, acquired-from, usage, year-made and the rest) is one its module's writer update writes, or every fill by role drops it without a word.
//
// THE BUG THIS PREVENTS. Assets declared Paid, Purchased at and Bought from as roled natives while its writer's update wrote only name, location, type and notes (#4523)
//
// THE RULE. In a module manifest (modules/<m>/src/module.ts), a native field
// declared with `fieldRole: "<role>"` (any role but identifier, which is read,
// never filled) must appear as `fields.<name>` in the module's registered
// writer (modules/<m>/src/api/sync-writer.ts, the file that calls
// registerWriter). The kernel's roledFieldsFor lists such a column first, the
// fill writes it through the writer's update, and an update that ignores the
// key drops the value while the fill reports it written.
//
// THE BOUNDARY. A module with no writer file is not judged (nothing fills its
// natives through a writer), and an identifier role is exempt: identity is
// matched against, not written by a fill.
//
//   npx tsx scripts/lint-native-role-fields-are-writable.ts   (pnpm lint native-role-fields-are-writable)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules"];

/** One offending place. `line` is 1-based for a clickable path:line. */
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
    else if (name === "module.ts") yield p;
  }
}

const violations: Violation[] = [];
for (const root of ROOTS) {
  for (const manifest of walk(root)) {
    const src = readFileSync(manifest, "utf8");
    const writerFile = manifest.replace(/module\.ts$/, "api/sync-writer.ts");
    let writer: string;
    try {
      writer = readFileSync(writerFile, "utf8");
    } catch {
      continue;
    }
    src.split("\n").forEach((line, i) => {
      const m = /\bname:\s*"([a-z_]+)"[^\n]*fieldRole:\s*"([a-z-]+)"/.exec(line);
      if (!m || m[2] === "identifier") return;
      if (!new RegExp(`\\bfields\\.${m[1]}\\b`).test(writer)) {
        violations.push({ file: manifest, line: i + 1, what: `${m[1]} declares fieldRole "${m[2]}" but ${writerFile} never writes fields.${m[1]}: a fill by role would drop it` });
      }
    });
  }
}

if (violations.length) {
  console.error(`lint:native-role-fields-are-writable - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:native-role-fields-are-writable OK`);
