#!/usr/bin/env tsx
// A deferred line in docs/BACKLOG.md carries a probe naming what will exist once it ships, and the lint fails the day that thing appears in the source, so a shipped item cannot stay listed as open.
//
// THE BUG THIS PREVENTS. About 15 shipped things were still listed as open in
// BACKLOG.md and the design docs on 2026-10-16 (#6912): the photo cross-check,
// the crop control, field labels on module lists, Move everything and more.
// Each cost a session time to re-verify and invited a duplicate build.
//
// THE RULE.
//   1. A probe is `<!-- open-while-absent: <term> -->` on a deferred line in
//      docs/BACKLOG.md, docs/modules or docs/design-decisions. <term> is what
//      the item will be built under: a function, an action id, a route. While
//      no shipping source file (api/src, web/src, modules, packages; tests
//      excluded) contains <term>, the line passes. The day one does, the lint
//      fails and names the file: strike the line, or, if the term turned up
//      for another reason, point the probe at something still absent.
//      An identifier-shaped term matches as a whole word; anything else
//      (`move-everything`, `POST /x`) matches as plain text.
//   2. Every item in BACKLOG.md's "Deferred in the ... docs" lists carries a
//      probe, or `<!-- no-probe: <why> -->` when nothing it would be built
//      under can be named yet (a design not settled, a taste call).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only shipping source counts:
// a test or fixture that names the future symbol (Fluidd's fixture lived in a
// test manifest long before anyone asked) is not the feature. Comments do
// count, so a probe must not name a word the code already uses in passing:
// `make-or-buy` sits in a builds comment saying it is "a later" thing, which is
// why that line names no probe. This lint does not take the changed-files
// shortcut: the line goes stale when CODE changes, so a code PR that ships a
// deferred item goes red until it strikes the line, which is the point.
//
// It never reads the source tree itself: one `git grep -F` over every probe
// term picks the lines, after a first version that read every file went
// over the 30 MB read budget on its first CI run.
//
//   npx tsx scripts/lint-deferred-has-a-probe.ts   (pnpm lint deferred-has-a-probe)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";

const DOC_ROOTS = ["docs/modules", "docs/design-decisions"];
const BACKLOG = "docs/BACKLOG.md";
const SOURCE_ROOTS = ["api/src", "web/src", "modules", "packages"];
const PROBE = /<!-- open-while-absent: (.+?) -->/g;
const NO_PROBE = /<!-- no-probe: \S.*?-->/;
const DEFERRED_LIST = /^##\s+Deferred in the .* docs\b/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, keep: (name: string) => boolean): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "tests" || name === "test" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, keep);
    else if (keep(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const isSource = (name: string) => /\.(ts|tsx|mts|mjs|js)$/.test(name) && !/\.(test|spec)\.[mc]?[jt]sx?$/.test(name) && !/\.d\.ts$/.test(name);

/** One line of shipping source that holds a probe's term. */
export interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Every shipping-source line holding any of `terms`, from ONE `git grep -F`:
 *  git picks the files, so the lint never reads the tree itself. */
function shippingHits(terms: string[]): Hit[] {
  if (!terms.length) return [];
  const args = ["grep", "-n", "-I", "-F", ...terms.flatMap((t) => ["-e", t]), "--", ...SOURCE_ROOTS];
  let out = "";
  try {
    out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // git grep exits 1 when nothing matches: every probe is still absent.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  const hits: Hit[] = [];
  for (const row of out.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    const file = m[1]!;
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (!isSource(name) || /(^|\/)(tests?|dist|node_modules)\//.test(file)) continue;
    hits.push({ file, line: Number(m[2]), text: m[3]! });
  }
  return hits;
}

/** Where `term` already exists in shipping source, or null while it is absent. */
export function foundAt(term: string, hits: Hit[]): string | null {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = /^[\w$]+$/.test(term) ? new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`) : new RegExp(escaped);
  const hit = hits.find((h) => re.test(h.text));
  return hit ? `${hit.file}:${hit.line}` : null;
}

/** Every probe in one doc whose term now exists, plus (for BACKLOG) every deferred-list item without one. */
export function check(file: string, text: string, hits: Hit[]): Violation[] {
  const out: Violation[] = [];
  const lines = text.split("\n");
  let inDeferredList = false;
  for (let i = 0; i < lines.length; i++) {
    // A probe quoted in inline code is an example of the syntax, not a probe.
    const line = (lines[i] ?? "").replace(/`[^`\n]*`/g, "");
    if (/^##\s/.test(line)) inDeferredList = file === BACKLOG && DEFERRED_LIST.test(line);
    for (const m of line.matchAll(PROBE)) {
      const term = m[1]!.trim();
      const at = foundAt(term, hits);
      if (at) out.push({ file, line: i + 1, what: `"${term}" now exists at ${at}: if this shipped, strike the line and move it into its doc's main text` });
    }
    if (inDeferredList && /^\s*- /.test(line) && !/<!-- open-while-absent: /.test(line) && !NO_PROBE.test(line)) {
      // An item with sub-items (a doc's name in bold) is a heading, not a deferral.
      const next = lines[i + 1] ?? "";
      const isGroup = /^- \*\*`[^`]+`\*\*\s*$/.test(lines[i] ?? "") && /^\s+- /.test(next);
      if (!isGroup) out.push({ file, line: i + 1, what: "a deferred item with no `<!-- open-while-absent: <term> -->` probe and no `<!-- no-probe: <why> -->`" });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const docs = [BACKLOG, ...DOC_ROOTS.flatMap((root) => [...walk(root, (n) => n.endsWith(".md"))])].map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const terms = [...new Set(docs.flatMap(({ text }) => [...text.replace(/`[^`\n]*`/g, "").matchAll(PROBE)].map((m) => m[1]!.trim())))];
  const hits = shippingHits(terms);
  const violations: Violation[] = [];
  for (const { file, text } of docs) violations.push(...check(file, text, hits));

  if (violations.length) {
    console.error(`lint:deferred-has-a-probe - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("strike the line (it shipped) or point the probe at something still absent");
    process.exit(1);
  }
  console.log(`lint:deferred-has-a-probe OK`);
}
