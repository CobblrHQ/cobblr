// Guard: docs-only.yml's `paths` must be the exact mirror of ci.yml's
// `paths-ignore`.
//
// The pair guarantees every commit reports at least one status. Drift breaks that
// silently, in both directions:
//
//   a filter in ci.yml but not docs-only.yml  -> that path gets NO status again
//                                                (the bug this pair was added to fix)
//   a filter in docs-only.yml but not ci.yml  -> a pure-docs commit under that
//                                                path runs the real build after
//                                                all, so the exemption you
//                                                thought you added does nothing
//
// (A MIXED commit legitimately runs both, since `paths` matches on ANY file and
// `paths-ignore` skips only on ALL. That is expected, not drift.)
//
// Nothing else can catch this: both files stay valid YAML, and CI passes either
// way, because the failure is an ABSENT status rather than a red one.
// Run: npx tsx scripts/lint-ci-paths-mirror.ts

import { readFileSync, existsSync } from "node:fs";

const CI = ".forgejo/workflows/ci.yml";
const DOCS = ".forgejo/workflows/docs-only.yml";
const SKILL = ".claude/skills/shipping-a-pr/SKILL.md";

for (const f of [CI, DOCS, SKILL]) {
  if (!existsSync(f)) {
    console.error(`ci-paths-mirror lint: ${f} is missing. If a workflow was renamed, update this lint rather than deleting it.`);
    process.exit(1);
  }
}

/** Collect every list item under each occurrence of `key:` in a YAML file.
 *  Deliberately not a YAML parser: this repo ships no YAML dep, and the shape
 *  here is a flat list of quoted globs. */
function globsUnder(text: string, key: string): Set<string> {
  const out = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^\\s*${key}:\\s*$`).test(lines[i]!)) continue;
    const indent = (lines[i]!.match(/^\s*/) ?? [""])[0]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const thisIndent = (line.match(/^\s*/) ?? [""])[0]!.length;
      const item = /^\s*-\s*'?"?([^'"#]+?)'?"?\s*$/.exec(line);
      if (item && thisIndent > indent) out.add(item[1]!.trim());
      // A list item this parser cannot read (trailing comment, flow style, an
      // anchor). Ending the list here would silently truncate it, and if the
      // SAME entry is edited in both files the two truncate at the same point,
      // the lint compares only what came above, and it reports ✓ while the real
      // drift sits below. So refuse rather than guess.
      else if (/^\s*-\s/.test(line) && thisIndent > indent) {
        console.error(
          `ci-paths-mirror lint: cannot parse this entry under \`${key}:\`\n` +
            `    ${line}\n` +
            `  Keep each entry a plain quoted glob with nothing after it (no trailing\n` +
            `  comment), or teach globsUnder() the new shape. Ending the scan here\n` +
            `  would hide any drift below this line.`,
        );
        process.exit(1);
      } else break;
    }
  }
  return out;
}

const ignored = globsUnder(readFileSync(CI, "utf8"), "paths-ignore");
const covered = globsUnder(readFileSync(DOCS, "utf8"), "paths");

if (ignored.size === 0) {
  console.error(`ci-paths-mirror lint: found no paths-ignore entries in ${CI}. If the filter was removed, ${DOCS} is now redundant and should go too.`);
  process.exit(1);
}

const missing = [...ignored].filter((p) => !covered.has(p));   // no status at all
const extra = [...covered].filter((p) => !ignored.has(p));     // both workflows run

if (missing.length || extra.length) {
  console.error(`ci-paths-mirror lint: ${DOCS} does not mirror ${CI}.\n`);
  if (missing.length) {
    console.error(`  Ignored by CI but NOT covered by docs-only (these commits get NO status,`);
    console.error(`  which reads as "CI never saw it"):`);
    for (const p of missing) console.error(`    ❌ ${p}`);
  }
  if (extra.length) {
    console.error(`  Covered by docs-only but NOT ignored by CI (both workflows run, so a`);
    console.error(`  green "skipped" status sits next to a real build):`);
    for (const p of extra) console.error(`    ❌ ${p}`);
  }
  console.error(`\n  Keep the two lists identical, so no commit can fall through both filters.`);
  process.exit(1);
}

// Third copy: the shipping-a-pr watcher greps a commit's changed paths against
// this same list to decide whether a blank CI status means "filtered, merge it".
// Drift there is worse than drift between the workflows, because it is silent
// and one-directional: a regex BROADER than paths-ignore makes the watcher call
// a commit CI should have built "a pass". Derive the expected regex and compare.
function globToRe(g: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (g.startsWith("**")) return `${esc(g.slice(2))}$`; //   **.md   -> \.md$
  if (g.endsWith("/**")) return `^${esc(g.slice(0, -2))}`; // docs/** -> ^docs/
  return `^${esc(g)}$`; //                                   LICENSE -> ^LICENSE$
}

const expected = `(${[...ignored].map(globToRe).join("|")})`;
const skillSrc = readFileSync(SKILL, "utf8");
const declared = /^IGNORED='(.+)'$/m.exec(skillSrc);

if (!declared) {
  console.error(`ci-paths-mirror lint: no \`IGNORED='...'\` line in ${SKILL}.`);
  console.error(`  Its CI watcher needs that list to tell "CI skipped this" from "CI never ran".`);
  console.error(`  Expected:  IGNORED='${expected}'`);
  process.exit(1);
}
if (declared[1] !== expected) {
  console.error(`ci-paths-mirror lint: ${SKILL}'s IGNORED regex does not match ${CI}.\n`);
  console.error(`    has:      ${declared[1]}`);
  console.error(`    expected: ${expected}\n`);
  console.error(`  The watcher uses this to decide a blank status is a PASS. Too broad and it`);
  console.error(`  waves through a commit CI should have built.`);
  process.exit(1);
}

console.log(
  `ci-paths-mirror lint: docs-only + shipping-a-pr mirror ci.yml (${ignored.size} path filters) ✓`,
);
