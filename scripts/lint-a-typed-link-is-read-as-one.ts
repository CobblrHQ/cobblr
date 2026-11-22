#!/usr/bin/env tsx
// A link a person types is read through readTypedLink from platform-contract (EditField with type url does), so an address typed without https:// is kept and another scheme is refused plainly; a native url input says why on a link-typed-ok line.
//
// THE BUG THIS PREVENTS. A part's Supplier URL typed on a phone as 'supplier.example/hinges' was refused as Not saved (2026-11-21, #4115)
//
// THE RULE. A native `<input type="url">` leaves the reading to the browser,
// which refuses an address typed without its scheme in its own words. A file
// that renders one reads the value through readTypedLink where it saves, or
// says why on a `link-typed-ok:` line in the six lines above the `<input`
// (the native forms still to convert name #9708). EditField with type "url"
// reads through readTypedLink itself, so a record's link field passes as it
// is.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only an input whose type is
// the literal "url" is judged; a field list that hands a renderer a type is
// that renderer's to read. Tests are not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-typed-link-is-read-as-one.ts   (pnpm lint a-typed-link-is-read-as-one)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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

function check(file: string, src: string): Violation[] {
  if (/\breadTypedLink\(/.test(src)) return [];
  const lines = src.split("\n");
  const out: Violation[] = [];
  for (const m of src.matchAll(/<input\b/g)) {
    const at = m.index!;
    let depth = 0, end = at + 6;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 0 && ch === ">") break;
    }
    if (!/\btype="url"/.test(src.slice(at, end))) continue;
    const line = src.slice(0, at).split("\n").length;
    if (/link-typed-ok: \S/.test(lines.slice(Math.max(0, line - 7), line).join("\n"))) continue;
    out.push({ file, line, what: "a native link input: an address typed without https:// is refused in the browser's words" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-typed-link-is-read-as-one - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Read it through readTypedLink (@cobblr/platform-contract/typed-link) where it saves, or EditField with type \"url\"; or // link-typed-ok: <why> above the input");
  process.exit(1);
}
console.log(`lint:a-typed-link-is-read-as-one OK`);
