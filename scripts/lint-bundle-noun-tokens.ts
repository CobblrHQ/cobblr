#!/usr/bin/env tsx
// A bundle table that offers words for its things never spells one of them in its labels, help or view names: it says {{noun}} or {{nouns}}, so the word the person picked is the word every screen uses.
//
// THE BUG THIS PREVENTS. Yarn's labels spelled skein, then ball, by hand (#3662); a table offering ball, skein or hank must not (#3650)
//
// THE RULE. For every table (top-level or inside a feature) whose manifest in
// bundles/*.json declares `noun`, its field labels and help, its field
// overrides' labels and its saved views' names must not contain any of the
// words on offer (singular or plural, whole word, any case). They say
// {{noun}} / {{nouns}} / {{Noun}} / {{Nouns}}, which the install fills. A
// table that declares no `noun` is not judged: its one word is the word.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Yarn's scan feature says
// "ball band": the printed label on a ball of yarn, a thing's name, not the
// unit. It lives in a feature description, not in a table's labels, so the
// scope stops at the table's own strings; a bundle's card and description are
// read before any word is picked and say the default.
//
// PROVE IT RED: put "Length / ball (m)" back in Yarn's source and run it.
//
//   npx tsx scripts/lint-bundle-noun-tokens.ts   (pnpm lint bundle-noun-tokens)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BUNDLES_DIR = "bundles";

interface Violation {
  file: string;
  what: string;
}

interface Words { singular: string; plural: string }
interface Inst {
  instance_name?: string;
  noun?: Words & { alternatives?: Words[] };
  field_defs?: Array<{ name?: string; display_label?: string; help?: string }>;
  field_overrides?: Array<{ name?: string; display_label?: string }>;
  saved_views?: Array<{ name?: string }>;
}

function check(file: string, manifest: { provides_instances?: Inst[]; features?: Array<{ provides_instances?: Inst[] }> }): Violation[] {
  const out: Violation[] = [];
  const insts = [...(manifest.provides_instances ?? []), ...(manifest.features ?? []).flatMap((f) => f.provides_instances ?? [])];
  for (const inst of insts) {
    if (!inst.noun) continue;
    const words = [inst.noun, ...(inst.noun.alternatives ?? [])].flatMap((w) => [w.singular, w.plural]).filter(Boolean);
    const spelt = (text: string | undefined): string | null => {
      if (!text) return null;
      const bare = text.replace(/\{\{[^}]*\}\}/g, " ");
      return words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(bare)) ?? null;
    };
    const at = (where: string, text: string | undefined) => {
      const w = spelt(text);
      if (w) out.push({ file, what: `${inst.instance_name}: ${where} spells "${w}" ("${text}"); say {{noun}} or {{nouns}}` });
    };
    for (const f of inst.field_defs ?? []) {
      at(`field ${f.name} label`, f.display_label);
      at(`field ${f.name} help`, f.help);
    }
    for (const f of inst.field_overrides ?? []) at(`override ${f.name} label`, f.display_label);
    for (const v of inst.saved_views ?? []) at(`view name`, v.name);
  }
  return out;
}

const violations: Violation[] = [];
for (const name of readdirSync(BUNDLES_DIR)) {
  if (!name.endsWith(".json") || name === "bundle-versions.lock.json") continue;
  const file = join(BUNDLES_DIR, name);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { manifest?: unknown };
  violations.push(...check(file, (raw.manifest ?? raw) as Parameters<typeof check>[1]));
}

if (violations.length) {
  console.error(`lint:bundle-noun-tokens - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:bundle-noun-tokens OK`);
