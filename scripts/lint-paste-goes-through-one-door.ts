#!/usr/bin/env tsx
// Every place a person can add a picture takes a pasted one through usePasteImage (or usePhotoPick / ScanPickerInput, which use it), nothing else listens for paste, and a paste takes what the area's upload button takes.
//
// THE BUG THIS PREVENTS. Paste worked in six places, each with its own listener, and nowhere else: not a record's photo, a part's gallery, a knowledge image or Add photos (2026-10-01)
//
// THE RULE. Two halves.
//   1. Nothing listens for paste on its own: no `addEventListener("paste"` and
//      no `onPaste=` outside the hook (packages/platform-web/src/usePasteImage.ts).
//      Six listeners on one window took one paste twice, and each read the
//      clipboard its own way.
//   2. A file that renders a file input that can take a picture registers a
//      paste area: it calls usePasteImage, or opens through usePhotoPick or
//      ScanPickerInput, which register their own. An input can take a picture
//      when its `accept` names an image, is not a literal (a variable, a
//      prop), or is missing.
//   3. A paste takes what the area's upload button takes. A file that registers
//      with usePasteImage AND renders a file input taking more than pictures
//      (no accept, a variable one, or a literal naming a document) passes the
//      hook an `accept:`. The door's default is pictures only, and that default
//      is how a pasted bill of sale became its own file name typed into the
//      inbox's search box while its upload button took the same PDF (#4523).
// A door that takes no pictures with a variable accept says so on a line
// above the input: `paste-ok: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A literal accept that names
// no image (a backup's .zip, a CSV import, a 3D file, a font) is not a photo
// door and passes without a word; SheetImportSheet's ACCEPTED_SHEETS is a
// variable, so it carries the annotation. Tests are not product.
//
//   npx tsx scripts/lint-paste-goes-through-one-door.ts   (pnpm lint paste-goes-through-one-door)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules", "ops-console/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
const HOOK_FILE = "packages/platform-web/src/usePasteImage.ts";
const REGISTERS = /\busePasteImage\(|\busePhotoPick\(|<ScanPickerInput\b/;

/** The opening tag starting at `at`: up to the first ">" outside {…}. */
function openingTag(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return src.slice(at, i);
  }
  return src.slice(at);
}

/** Whether any file input here takes more than pictures. */
function takesDocuments(src: string): boolean {
  for (const m of src.matchAll(/<input\b/g)) {
    const tag = openingTag(src, m.index ?? 0);
    if (!/type=["']file["']/.test(tag)) continue;
    const accept = /accept=("([^"]*)"|\{)/.exec(tag);
    if (!accept) return true;
    if (accept[2] === undefined) return true;
    if (accept[2].split(",").some((r) => !/^\s*image\//i.test(r))) return true;
  }
  return false;
}

/** Whether every usePasteImage call here says which files it takes. */
function everyPasteSaysAccept(src: string): boolean {
  for (const m of src.matchAll(/\busePasteImage\(/g)) {
    let depth = 0;
    let end = m.index ?? 0;
    for (let i = end; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (!/\baccept\s*(?::|,|\s*})/.test(src.slice(m.index ?? 0, end))) return false;
  }
  return true;
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  if (file !== HOOK_FILE) {
    for (const m of src.matchAll(/addEventListener\(\s*["']paste["']|\bonPaste=/g)) {
      out.push({ file, line: lineOf(m.index ?? 0), what: "a paste listener of its own: register with usePasteImage" });
    }
  }
  if (REGISTERS.test(src)) {
    if (/\busePasteImage\(/.test(src) && takesDocuments(src) && !everyPasteSaysAccept(src)) {
      const at = src.search(/\busePasteImage\(/);
      out.push({ file, line: lineOf(at), what: "its file input takes documents but its paste takes pictures only: pass usePasteImage the same accept" });
    }
    return out;
  }
  for (const m of src.matchAll(/<input\b/g)) {
    const at = m.index ?? 0;
    const tag = openingTag(src, at);
    if (!/type=["']file["']/.test(tag)) continue;
    const accept = /accept=("([^"]*)"|\{)/.exec(tag);
    const literal = accept && accept[2] !== undefined ? accept[2] : null;
    if (literal !== null && !/image/i.test(literal)) continue;
    const before = src.slice(Math.max(0, at - 300), at);
    if (/paste-ok:\s*\S/.test(before)) continue;
    out.push({ file, line: lineOf(at), what: "a file input that takes pictures, with no paste (usePasteImage)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:paste-goes-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Register the area with usePasteImage(area, { onFiles }) from @cobblr/platform-web; a door that takes no pictures says so with // paste-ok: <why>");
  process.exit(1);
}
console.log(`lint:paste-goes-through-one-door OK`);
