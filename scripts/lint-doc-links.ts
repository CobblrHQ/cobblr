// Guard: a relative link in a MAINTAINED doc must point at something real.
//
// WHY THIS IS A LINT: docs/README.md is the map AND the router — the thing every
// agent is told to consult before writing docs. It listed
// `architecture/traits-stress-test.md` for weeks after that file was deleted, in
// the same commit that ADDED a doc-drift guardrail. A dead link in an index does
// not error, does not render red, and reads exactly like coverage: someone
// follows it, finds nothing, and concludes the doc is missing rather than that
// the map is wrong.
//
// It is the same shape as every other rot this repo has been bitten by — a
// pointer outliving its target — and the cheapest fix is to check that pointers
// resolve.
//
// SCOPE. Cross-repo links are skipped — a path that escapes this checkout
// (`../../business-models/…`) resolves only on a machine with the sibling repo
// beside it, so verifying it would make the answer depend on local directory
// layout rather than on the commit. `docs/history/` is EXCLUDED: the map says plainly it is "superseded /
// frozen records ... kept for the paper trail; **not** maintained". Demanding
// live links inside frozen history would either force edits to records that are
// supposed to be immutable, or make this lint permanently baselined noise.
//
// BASELINED. 29 links outside history/ were already broken when this shipped
// (mostly walkthrough screenshots and three docs deleted in a bucket
// reorganisation). They are recorded in scripts/doc-links-baseline.json so this
// can stop NEW rot today rather than waiting for a cleanup that may never be
// scheduled. Fixing one and pruning its baseline entry is always welcome; the
// lint tells you when an entry has gone stale.
//
// Run: npx tsx scripts/lint-doc-links.ts

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "doc-links-baseline.json");
const WRITE = process.argv.includes("--write");

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "history") continue; // frozen by design — see header
      out.push(...markdownFiles(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

type Broken = { file: string; link: string };
const key = (b: Broken) => `${b.file} -> ${b.link}`;

const broken: Broken[] = [];
for (const file of markdownFiles(join(ROOT, "docs"))) {
  const src = readFileSync(file, "utf8");
  // Relative links only. Absolute URLs, mailto:, and bare anchors are not ours
  // to verify, and a link carrying an <angle> placeholder is illustrative.
  for (const m of src.matchAll(/\]\((\.{1,2}\/[^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    const link = m[1]!;
    if (link.includes("<") || link.includes(">")) continue;
    const target = resolve(dirname(file), link);
    // A link that ESCAPES this repo (../../business-models/…, ../../cloud/…) is
    // not ours to verify: it resolves on a machine that happens to have the
    // sibling repo checked out next door and not in CI, so checking it would
    // make this lint answer differently per machine. It did exactly that — green
    // on the author's Mac, seven failures in CI, on the same commit.
    if (!target.startsWith(ROOT + "/")) continue;
    if (existsSync(target)) continue;
    broken.push({ file: relative(ROOT, file), link });
  }
}

if (WRITE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(broken, null, 2) + "\n");
  console.log(`[lint:doc-links] wrote ${broken.length} entries to ${relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline: Broken[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Broken[])
  : [];
const allowed = new Set(baseline.map(key));
const fresh = broken.filter((b) => !allowed.has(key(b)));
const live = new Set(broken.map(key));
const stale = baseline.filter((b) => !live.has(key(b)));

if (fresh.length === 0) {
  let msg = `✓ doc-links lint: every relative link in the maintained docs resolves (${baseline.length} baselined)`;
  if (stale.length) {
    msg += `\n  (${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} stale — now fixed; prune scripts/doc-links-baseline.json)`;
  }
  console.log(msg);
  process.exit(0);
}

console.error(`✗ lint-doc-links: ${fresh.length} doc link(s) point at nothing:\n`);
for (const b of fresh) console.error(`    ${b.file}  ->  ${b.link}`);
console.error(
  "\n  Fix the path, or delete the reference. A pointer that outlives its target\n" +
    "  reads as coverage: the next person follows it, finds nothing, and concludes\n" +
    "  the DOC is missing rather than that the map is wrong.\n" +
    "\n  If a target is genuinely coming later, land them together.\n",
);
process.exit(1);
