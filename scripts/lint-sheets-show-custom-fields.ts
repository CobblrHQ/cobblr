#!/usr/bin/env tsx
// Every entity kind with a detail page shows its custom fields: some sheet file that names the kind renders <CustomFieldsPanel>, so a field a bundle or a person defines on the kind is never invisible.
//
// THE BUG THIS PREVENTS. Small shop defined Due date, Came in through and Sells for on sales orders and builds, and neither sheet drew them (#4142, 2026-09-30)
//
// THE RULE. For every entity kind a module declares with a `detailRoute`
// (it has a sheet a person opens), some .tsx file outside tests must both
// render `<CustomFieldsPanel` and name the kind as a quoted string. That is
// how a sheet shows the fields a bundle or a person adds on /fields: the
// panel reads the kind's field defs and edits the record's metadata.
//
// NO EXCEPTIONS. It began as a ratchet over 13 kinds without such a sheet;
// the last of them gained one on 2026-09-30 and the baseline was deleted, so
// every kind with a detail page is held. There is no annotation opt-out; a
// kind that truly holds no custom fields should not have fields offered for
// it, which is a different change.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first scan matched
// `entityKind="<kind>"` literally and missed every page that passes the kind
// through a variable (inventory's part page, the assets, machines and records
// pages). The second counted any module whose UI renders the panel, which
// passed sales:customer because the ORDER sheet in the same module has it.
// The rule is now the file: the kind named in the same file that renders the
// panel.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-sheets-show-custom-fields.ts   (pnpm lint sheets-show-custom-fields)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "web/src", "packages/platform-web/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const violations: Violation[] = [];

/** Kinds with a sheet: `id: "<module>:<kind>"` whose object declares a
 *  detailRoute and a displayName (an entity kind, not an action). */
function kindsWithSheets(): Array<{ kind: string; file: string; line: number }> {
  const out: Array<{ kind: string; file: string; line: number }> = [];
  let mods: string[] = [];
  try {
    mods = readdirSync("modules");
  } catch {
    return out;
  }
  for (const m of mods) {
    const file = join("modules", m, "src", "module.ts");
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const re = /id:\s*"([a-z0-9-]+:[a-z0-9_-]+)"/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(src))) {
      const next = src.indexOf('id: "', hit.index + hit[0].length);
      const seg = src.slice(hit.index + hit[0].length, next === -1 ? src.length : next);
      if (seg.includes("detailRoute") && seg.includes("displayName")) {
        out.push({ kind: hit[1]!, file, line: src.slice(0, hit.index).split("\n").length });
      }
    }
  }
  return out;
}

const panelFiles: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (!file.endsWith(".tsx")) continue;
    const src = readFileSync(file, "utf8");
    if (src.includes("<CustomFieldsPanel")) panelFiles.push(src);
  }
}
const shows = (kind: string) => panelFiles.some((src) => src.includes(`"${kind}"`) || src.includes(`'${kind}'`) || src.includes(`\`${kind}\``));

for (const k of kindsWithSheets()) {
  if (!shows(k.kind)) {
    violations.push({ file: k.file, line: k.line, what: `${k.kind} has a detail page, and no sheet that names it renders <CustomFieldsPanel>` });
  }
}

if (violations.length) {
  console.error(`lint:sheets-show-custom-fields - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("render <CustomFieldsPanel entityKind=\"<kind>\" …> on the kind's sheet");
  process.exit(1);
}
console.log(`lint:sheets-show-custom-fields OK`);
