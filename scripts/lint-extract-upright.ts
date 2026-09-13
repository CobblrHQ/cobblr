#!/usr/bin/env tsx
// A crop of a photo's pixels is cut from the picture as displayed: every sharp extract in core-scan runs on uprightBytes output or after rotate().
//
// THE BUG THIS PREVENTS. A split of a phone photo cut each child from the stored raster, a quarter turn from what the model boxed, and handed it a patch of the table (2026-09-13, #2945).
//
// THE RULE. Every `.extract(` in core-scan's sources is cut from pixels that
// were oriented first. A chain passes when it calls `.rotate(` before the
// extract (sharp bakes the EXIF turn in), or when the bytes handed to `sharp(`
// come from `uprightBytes` (trim-margins.ts): the identifier is the one
// assigned from `await uprightBytes(`, its `.bytes`, a name destructured from
// it, or a name assigned from an expression that mentions one of those. A
// function whose PARAMETER is already upright by contract says so on the line:
//   // extract-upright: <why these bytes are already upright>
// Anything else fails: a box is drawn on the picture as displayed, and a
// phone stores its raster a quarter turn from that.
//
//   npx tsx scripts/lint-extract-upright.ts   (pnpm run lint:extract-upright)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/core-scan/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Names in this file that hold oriented bytes, by a small textual dataflow. */
function uprightNames(src: string): Set<string> {
  const names = new Set<string>();
  const lines = src.split("\n");
  // Seeds: `const up = await uprightBytes(`.
  for (const line of lines) {
    const m = line.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+uprightBytes\(/);
    if (m) names.add(m[1]!);
  }
  // Grow: destructuring from an upright name, or an assignment whose right
  // side mentions one. A few passes settle it.
  for (let pass = 0; pass < 4; pass++) {
    const before = names.size;
    for (const line of lines) {
      const d = line.match(/(?:const|let)\s+\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)\b/);
      if (d && names.has(d[2]!)) {
        for (const part of d[1]!.split(",")) {
          const m = part.trim().match(/^(?:bytes\s*:\s*)?([A-Za-z_$][\w$]*)$/) ?? part.trim().match(/^bytes$/);
          if (m) names.add(m[1] ?? "bytes");
        }
      }
      const a = line.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
      if (a && !names.has(a[1]!)) {
        const rhs = a[2]!;
        for (const n of names) {
          if (new RegExp(`\\b${n}\\b`).test(rhs)) {
            names.add(a[1]!);
            break;
          }
        }
      }
    }
    if (names.size === before) break;
  }
  return names;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const upright = uprightNames(src);
  // The file that defines uprightBytes cuts its own output.
  if (/export async function uprightBytes\(/.test(src)) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\.extract\(/.test(line)) continue;
    if (/\/\/ extract-upright: \S/.test(line)) continue;
    // The statement this extract belongs to: back to the nearest `sharp(`.
    let start = i;
    while (start > 0 && !/\bsharp\(/.test(lines[start] ?? "")) start--;
    const chain = lines.slice(start, i + 1).join("\n");
    if (/\.rotate\(/.test(chain)) continue;
    const src_ = chain.match(/\bsharp\(\s*([A-Za-z_$][\w$]*)(\.bytes)?/);
    const name = src_?.[1] ?? "";
    if (name && upright.has(name)) continue;
    out.push({
      file,
      line: i + 1,
      what: `.extract( on ${name ? `\`${name}\`` : "an expression"} that is not uprightBytes output and has no .rotate() in the chain`,
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:extract-upright - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:extract-upright OK`);
