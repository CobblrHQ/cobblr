// The field-TYPE union has ONE source: FIELD_TYPE_VALUES in
// @cobblr/platform-contract. A hand-written copy is what this lint fails on.
//
// It existed in five places and had drifted three different ways. The one that
// mattered: `relation` shipped into the bundle manifest, the stored schema, the
// resolver and the read types, but never into the write route or the field
// builder's type picker. So a relation field was creatable only by authoring a
// bundle. Nothing failed, nothing warned, and the changelog for that PR had
// promised "a general-purpose picker in the field builder follows" a month
// earlier. A feature can look finished from every angle except the one a user
// stands in.
//
// A site that legitimately allows FEWER types should say so out loud
// (`FieldTypeSchema.exclude([...])`) so a restriction is a decision rather than
// an omission nobody noticed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "packages/platform-contract/src/index.ts");
const SCAN = ["api/src", "web/src", "modules", "packages"];
const SKIP = /node_modules|dist|\.test\.|__tests__/;

/** Types that, appearing together as literals, mean somebody re-typed the union.
 *  Two is coincidence; these four together is a copy. */
const TELLTALE = ['"richtext"', '"computed"', '"relation"'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (SKIP.test(full)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const TYPES = new Set([
  "text", "number", "boolean", "date", "url", "richtext", "computed", "relation", "member",
]);

/** Runs of string literals joined only by `|` or `,` — i.e. an actual union or
 *  array literal, not two unrelated mentions in the same file. */
const RUN = /"[a-z-]+"(?:\s*[|,]\s*"[a-z-]+")+/g;

const violations: string[] = [];

for (const root of SCAN) {
  for (const file of walk(join(ROOT, root))) {
    if (file === SOURCE) continue;
    const raw = readFileSync(file, "utf8");
    // Comments carry prose that looks like literals; strip them first.
    const code = raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const flat = code.replace(/\s+/g, " ");

    for (const run of flat.match(RUN) ?? []) {
      const members = (run.match(/"[a-z-]+"/g) ?? []).map((m) => m.slice(1, -1));
      const mine = members.filter((m) => TYPES.has(m)).length;
      // A copy of THIS union: mostly our members, and enough of them to be it
      // rather than an incidental overlap. `FieldControl` in platform-web shares
      // "computed"/"relation"/"number"/"date" but is over half foreign members,
      // so it is a different union and stays legal.
      if (mine >= 5 && mine / members.length >= 0.8) {
        const at = raw.split("\n").findIndex((l) => l.includes(`"${members[0]}"`));
        violations.push(`${relative(ROOT, file)}:${at + 1}: ${run.slice(0, 110)}`);
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Hand-written copies of the field-type union (${violations.length}):\n` +
      `${violations.join("\n")}\n\n` +
      `Import it instead:\n` +
      `  import { FIELD_TYPE_VALUES, FieldTypeSchema, type FieldDefType } from "@cobblr/platform-contract";\n` +
      `Allowing fewer types is fine, but say so: FieldTypeSchema.exclude(["computed"]) with a reason.\n` +
      `A silent omission is how \`relation\` stayed uncreatable by users for a month.`,
  );
  process.exit(1);
}
console.log(`lint:field-type-enum - one field-type union, no copies ✓`);
