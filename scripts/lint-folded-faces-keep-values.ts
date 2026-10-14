#!/usr/bin/env tsx
// A face folds what a record does not use, and never hides a value it holds.
//
// THE BUG THIS PREVENTS. Three printers came in from an import as "5 of
// these", "3 of these" and "2 of these", in a collection that does not wear
// the stock face. The machine's quantity was gated on the face (and on not
// being in a specialised instance), so the record showed no quantity at all:
// the count was counted in totals and invisible and uneditable on the record
// itself (2026-09-28). An asset's warranty date went the same way.
//
// THE RULE. In any .tsx under web/src, packages/platform-web/src or a
// module's src/ui:
//   - a boolean handed out by <FacesOn> (`({ stock: stockOn }) =>`) is only
//     ever read as the first argument of faceShows(on, value, fallback),
//     which keeps the field while the record holds anything but its default;
//   - every <FaceSection> passes `holds=`, what the record already has in
//     that section (units on file, contents), so a folded face never hides it.
// A section with genuinely nothing a record can hold says so on its line:
// `FACE-HOLDS: <reason>` in a comment.
//
// PROVEN RED on MachinesPage.tsx as it shipped (quantity gated on stockOn
// directly) and on AssetsPage.tsx (warranty and service dates the same).
//
//   npx tsx scripts/lint-folded-faces-keep-values.ts   (pnpm lint folded-faces-keep-values)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const SKIP = /(^|\/)faces\.tsx$/;

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && (!p.startsWith("modules") || /\/src\/ui(\/|$)/.test(p))) yield p;
  }
}

const lineOf = (src: string, i: number) => src.slice(0, i).split("\n").length;

function check(file: string, src: string): Violation[] {
  if (SKIP.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");

  for (let m, re = /<FaceSection\b[^>]*>/g; (m = re.exec(src)); ) {
    const ln = lineOf(src, m.index);
    if (/\bholds=/.test(m[0])) continue;
    if (/FACE-HOLDS: \S/.test(`${lines[ln - 2] ?? ""}\n${lines[ln - 1] ?? ""}`)) continue;
    out.push({ file, line: ln, what: "a <FaceSection> without holds=: when the face is off it hides whatever the record already has there. Pass holds={<the record holds something here>}, or say why nothing can be held: FACE-HOLDS: <reason>" });
  }

  for (let m, re = /<FacesOn\b[^>]*>\s*\{\s*\(\s*\{([^}]*)\}\s*\)\s*=>/g; (m = re.exec(src)); ) {
    const end = src.indexOf("</FacesOn>", m.index);
    const body = src.slice(m.index + m[0].length, end === -1 ? undefined : end);
    const names = m[1]!.split(",").map((b) => b.trim()).filter(Boolean).map((b) => (b.includes(":") ? b.split(":")[1]!.trim() : b));
    for (const name of names) {
      for (let u, ure = new RegExp(`\\b${name}\\b`, "g"); (u = ure.exec(body)); ) {
        if (/faceShows\(\s*$/.test(body.slice(0, u.index))) continue;
        out.push({
          file,
          line: lineOf(src, m.index + m[0].length + u.index),
          what: `${name} gates a field directly: with the face off it hides a value the record holds. Write faceShows(${name}, <the value>, <its default>)`,
        });
      }
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:folded-faces-keep-values - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  process.exit(1);
}
console.log("lint:folded-faces-keep-values OK");
