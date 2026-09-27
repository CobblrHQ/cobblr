#!/usr/bin/env tsx
// A password or key field is a PasswordInput, never a raw type=password input, so every one can be shown
//
// THE BUG THIS PREVENTS. The owner, making an account on a phone (2026-09-27):
// the password field had no way to see what was typed. Twenty-four fields
// across sign-up, sign-in, keeping a sandbox, resets, account settings and the
// keys and tokens a connection asks for were each a raw type="password" input,
// so fixing one left twenty-three. They are all PasswordInput
// (@cobblr/platform-web) now, with the eye, and a new raw one would quietly be
// the one field without it.
//
// THE RULE. Outside PasswordInput.tsx, an <input> whose type is the string
// "password" fails: type="password", type={"password"}, or a type expression
// that can produce "password" (type={shown ? "text" : "password"}). Use
// <PasswordInput> (what="API key" / "token" for a key). A genuine exception
// says `// raw-password-ok: <reason>` on the line.
//
// THE BOUNDARY. A data-driven field whose type arrives as a value
// (type={f.type}) cannot be read here; the notification channels form had one
// and was fixed by hand to render PasswordInput for f.type === "password".
// That is the case this lint cannot see, and why it is written down.
//
//   npx tsx scripts/lint-raw-password-input.ts   (pnpm lint raw-password-input)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules", "ops-console"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "PasswordInput.tsx") yield p;
  }
}

/** A type attribute that is, or can be, the string "password". */
const RAW = /\btype=(?:"password"|\{[^}]*["'`]password["'`][^}]*\})/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/raw-password-ok: \S/.test(line)) continue;
    if (RAW.test(line)) out.push({ file, line: i + 1, what: `a raw password input: ${line.trim().slice(0, 120)}` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:raw-password-input - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:raw-password-input OK`);
