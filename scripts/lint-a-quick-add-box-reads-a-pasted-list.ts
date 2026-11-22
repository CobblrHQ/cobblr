#!/usr/bin/env tsx
// A one-line box that adds a thing (its placeholder starts with Add) reads a pasted list through pastedListProps from platform-web, one thing per line, or says why on a paste-one-line-ok line.
//
// THE BUG THIS PREVENTS. A shopping list pasted from Notes on a phone was added as one item called '- [ ] 2 oat milk • eggs 3. bread' (2026-11-21, #4115)
//
// THE RULE. An `<input` whose placeholder starts with "Add " (the quick-add
// box under a list) spreads pastedListProps(...) (platform-web), so a pasted list
// is offered as one thing per line, its bullets gone and its counts kept. A box
// where one thing at a time is right says why on a `// paste-one-line-ok:` line
// (or `{/* paste-one-line-ok: … */}`) on the line above the `<input`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A textarea keeps its lines,
// so only an input is judged. A placeholder that only starts with "Add" as part
// of another word ("Address") is not a quick-add box. Tests are not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-quick-add-box-reads-a-pasted-list.ts   (pnpm lint a-quick-add-box-reads-a-pasted-list)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = ["modules", "web/src", "packages/platform-web/src"];

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** Every `<input …>` element: its text and the line it starts on. */
function inputs(src: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const open = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    // The element ends at the first "/>" or ">" outside braces.
    let depth = 0, i = m.index + 6;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 0 && ch === ">") break;
    }
    out.push({ text: src.slice(m.index, i + 1), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

function check(file: string, src: string): Violation[] {
  const lines = src.split("\n");
  const out: Violation[] = [];
  for (const el of inputs(src)) {
    if (!/placeholder=(?:"|\{["'`])Add\s/.test(el.text)) continue;
    if (/pastedListProps\(/.test(el.text)) continue;
    if (/paste-one-line-ok: \S/.test(lines[el.line - 2] ?? "")) continue;
    out.push({ file, line: el.line, what: "a quick-add box that takes a pasted list as one thing" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-quick-add-box-reads-a-pasted-list - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("{...pastedListProps((lines) => …)} from @cobblr/platform-web on the box, or // paste-one-line-ok: <why one thing at a time is right>");
  process.exit(1);
}
console.log(`lint:a-quick-add-box-reads-a-pasted-list OK`);
