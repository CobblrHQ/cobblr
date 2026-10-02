#!/usr/bin/env tsx
// A module's native serial_number field declares fieldRole identifier, so a serial, a VIN or a hull number printed on paperwork or a label finds the record it is on.
//
// THE BUG THIS PREVENTS. Assets and machines kept serial_number without the role, so a vehicle's VIN on a bill of sale matched the car only by name (#4523)
//
// THE RULE. In a module manifest (modules/*/src/module.ts), a kind's field
// declared as `{ name: "serial_number", ... }` carries `fieldRole:
// "identifier"` on the same line. That role is how every identity match finds
// a record by a code (the scan inbox's "you already have it", the duplicate
// finder, the resolvable registry); without it the serial is invisible to all
// of them. A kind whose serial is genuinely not an identifier says why with
// `// NOT-AN-IDENTIFIER: <reason>` on the line.
//
// And where that module's api/resolvers.ts keeps a native filter set
// (`const NATIVE = columnSet...`), serial_number is in it: every identity
// match asks the list for { serial_number }, and a resolver that leaves it out
// reads it from metadata and matches nothing.
//
// THE BOUNDARY. Only the native field named serial_number in a manifest:
// a bundle's custom identifier fields declare their role in the bundle, and
// fields that merely mention a serial (a part number list, a log) are not
// a kind's native serial.
//
//   npx tsx scripts/lint-native-serial-is-an-identifier.ts   (pnpm lint native-serial-is-an-identifier)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules"];

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
    else if (name === "module.ts") yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bname:\s*"serial_number"/.test(line)) continue;
    if (/fieldRole:\s*"identifier"/.test(line) || /\/\/ NOT-AN-IDENTIFIER: \S/.test(line)) continue;
    out.push({ file, line: i + 1, what: 'serial_number without fieldRole: "identifier": a code on paperwork or a label cannot find this record' });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

// And the module's list answers a filter on it. Every identity match asks
// entities.list({ filter: { serial_number } }); a resolver whose native
// filter set leaves it out reads it from `metadata`, finds nothing, and the
// role is declared for no one (assets, #4523).
for (const root of ROOTS) {
  for (const manifest of walk(root)) {
    const src = readFileSync(manifest, "utf8");
    if (!/name:\s*"serial_number"[^\n]*fieldRole:\s*"identifier"/.test(src)) continue;
    const resolvers = manifest.replace(/module\.ts$/, "api/resolvers.ts");
    let rsrc: string;
    try {
      rsrc = readFileSync(resolvers, "utf8");
    } catch {
      continue;
    }
    rsrc.split("\n").forEach((line, i) => {
      if (/const NATIVE = columnSet/.test(line) && !/"serial_number"/.test(line)) {
        violations.push({ file: resolvers, line: i + 1, what: "the native filter set leaves out serial_number: a filter on the identifier reads metadata and never matches" });
      }
    });
  }
}

if (violations.length) {
  console.error(`lint:native-serial-is-an-identifier - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:native-serial-is-an-identifier OK`);
