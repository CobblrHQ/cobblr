#!/usr/bin/env tsx
// A create form (a RecordFormModal titled New or Add) keeps what is typed into it through useCreateDraft from @cobblr/platform-web, per workspace and person until the create lands, or says on a // draft-not-kept: line why nothing typed is lost.
//
// THE BUG THIS PREVENTS. A new part's name typed on a phone was gone after a reload, a dropped tab or a stray Escape (2026-11-20, #4115)
//
// THE RULE. A .tsx file that renders a RecordFormModal whose title holds a
// "New ..." or "Add ..." text (a literal, a template, or one side of a
// ternary like editing ? "Edit location" : "New location") is a create form.
// It passes when it calls useCreateDraft(, which keeps what is typed on the
// device per workspace and signed-in person until the create lands, or when it
// carries `// draft-not-kept: <why nothing typed is lost>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. An edit form ("Edit
// location") holds the record itself and is not judged; a form opened with a
// seed (a scan, a receipt) passes the hook `open: false` and keeps nothing,
// by design. Forms whose title is built elsewhere and handed in are not seen:
// the five most used create forms drew the scope, and their titles are all
// written where the modal is.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-create-form-keeps-what-is-typed.ts   (pnpm lint a-create-form-keeps-what-is-typed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx")) return [];
  const at = src.search(/<RecordFormModal\b[^>]*\btitle=\{?[^>]*["`'](New|Add) /);
  if (at < 0) return [];
  if (/\buseCreateDraft\(/.test(src)) return [];
  if (/\/\/ draft-not-kept: \S/.test(src)) return [];
  return [{ file, line: src.slice(0, at).split("\n").length, what: "a create form keeps nothing typed into it: a reload or a stray close loses it" }];
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-create-form-keeps-what-is-typed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Call useCreateDraft({ form, slug, token, values, empty, restore, open }) and render <CreateDraftNote>, clearing it on success; or add // draft-not-kept: <why nothing typed is lost>");
  process.exit(1);
}
console.log(`lint:a-create-form-keeps-what-is-typed OK`);
