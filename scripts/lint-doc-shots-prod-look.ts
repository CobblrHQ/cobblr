#!/usr/bin/env tsx
// A walkthrough whose screenshots a docs/walkthroughs page publishes has a driven script that writes its folder and renders production chrome through prodLook, so every committed shot can be regenerated and none carries a DEV badge or a verify-email strip.
//
// THE BUG THIS PREVENTS. Every committed shot of the Cobblr for Yarn
// walkthrough carried an orange DEV badge and an "email unverified" account
// menu, because the script hid the verify strip by DOM surgery and left the
// badge to an api env var the rig never sets (#3341). The videos and the other
// walkthroughs go through e2e/prod-look.mjs, which rewrites /healthz and the
// session responses at the network layer, so the app renders production chrome
// by itself; a script that reinvents that with querySelector gets it wrong in
// a way nobody sees until the pictures are committed.
//
// THE RULE. A docs/walkthroughs/*.md page publishes the pictures under
// docs/walkthroughs/<dir>/. The script that produces them is the e2e/*.mjs
// whose OUT resolves to _tmp/<dir> (the runner copies _tmp/<dir> to the doc
// folder by that name). Every such script must call prodLook( from
// ./prod-look.mjs on a line that runs. Scripts whose shots stay in _tmp (the
// asserting yardsticks) are not judged: nothing publishes them. A doc folder
// with NO producing script at all is a violation too: a published picture
// nobody can reproduce is not stale, it is unrefreshable, and it rots by
// construction (bjorn-lego-user-flow's nineteen pictures were a hand-driven
// May session showing a navigation the product no longer had, published the
// whole time; #3344 was five more such folders). The producer is found by the
// `_tmp/<dir>` its OUT resolves to, so a script whose folder name does not
// match the doc folder is the same miss (one demo's yardstick wrote
// `_tmp/<demo>` for a page publishing `./<demo>-flow/`, and the nightly's
// fresh-picture overlay silently never matched either).
//
// A walkthrough that must show the dev chrome on purpose opts out with
// `// doc-shots: allow <reason>` beside its OUT line; the allowance prints.
//
// PROVED RED 2026-09-21 against main's cobblr-for-yarn-full-walkthrough.mjs
// (hand-rolled hideSnapshotChrome, no prodLook); green once it imported the
// shim. The no-producer rule PROVED RED 2026-09-22 against main's five
// orphan folders (the workshop demo's flow, review-test-pack,
// capture-first-full, yarn-instances, the inbox-import walkthrough); green
// once each had a script writing it.
//
//   npx tsx scripts/lint-doc-shots-prod-look.ts   (pnpm run lint:doc-shots-prod-look)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DOCS = "docs/walkthroughs";
const E2E = "e2e";

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, accept: (n: string) => boolean): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, accept);
    else if (accept(name)) yield p;
  }
}

// ── which doc folders are published ──
const published = new Set<string>();
for (const md of walk(DOCS, (n) => n.endsWith(".md"))) {
  const src = readFileSync(md, "utf8");
  for (const m of src.matchAll(/!\[[^\]]*\]\(\.\/([^/)]+)\//g)) published.add(m[1]!);
}

// ── which script produces each folder ──
// OUT = resolve(HERE, "../_tmp/<dir>"...) or "_tmp/<dir>" — the dir is the
// first path segment after _tmp/.
const producers = new Map<string, string[]>();
const scripts = [...walk(E2E, (n) => n.endsWith(".mjs"))];
const srcOf = new Map<string, string>();
for (const file of scripts) {
  const src = readFileSync(file, "utf8");
  srcOf.set(file, src);
  for (const m of src.matchAll(/_tmp\/([A-Za-z0-9_-]+)/g)) {
    const dir = m[1]!;
    if (!producers.has(dir)) producers.set(dir, []);
    if (!producers.get(dir)!.includes(file)) producers.get(dir)!.push(file);
  }
}

const live = (src: string) =>
  src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !(l.startsWith("//") || l.startsWith("*") || l.startsWith("/*")))
    .join("\n");

const violations: Violation[] = [];
const orphans: string[] = [];
for (const dir of [...published].sort()) {
  if (!existsSync(join(DOCS, dir))) continue;
  const files = producers.get(dir) ?? [];
  if (!files.length) {
    orphans.push(dir);
    continue;
  }
  for (const file of files) {
    const src = srcOf.get(file)!;
    const outLine = src.split("\n").findIndex((l) => l.includes(`_tmp/${dir}`)) + 1;
    const allow = /\/\/\s*doc-shots:\s*allow\s+(.+)$/m.exec(src.split("\n")[outLine - 1] ?? "");
    if (allow) {
      console.error(`[lint:doc-shots-prod-look] allowance honoured at ${file}:${outLine} - ${allow[1]!.trim()}`);
      continue;
    }
    if (!/\bprodLook\(/.test(live(src))) {
      violations.push({
        file,
        line: outLine,
        what: `writes docs/walkthroughs/${dir}/ (published by a walkthrough page) without prodLook(): its shots carry the DEV badge and the verify-email strip`,
      });
    }
  }
}

for (const dir of orphans) {
  const md = [...walk(DOCS, (n) => n.endsWith(".md"))].find((f) => readFileSync(f, "utf8").includes(`](./${dir}/`)) ?? `${DOCS}/${dir}`;
  violations.push({
    file: md,
    line: 1,
    what: `publishes ./${dir}/ and no e2e script writes _tmp/${dir}: nothing can regenerate these pictures (give the page a driven script whose OUT is _tmp/${dir}, or stop publishing them)`,
  });
}
if (violations.length) {
  console.error(`lint:doc-shots-prod-look - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Call prodLook(page.context()) from ./prod-look.mjs right after the page exists, and take shots through waitReady.");
  process.exit(1);
}
console.log(`lint:doc-shots-prod-look OK (${published.size} published folders, every one with a producing script)`);
