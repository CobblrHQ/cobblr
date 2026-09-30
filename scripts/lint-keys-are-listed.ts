#!/usr/bin/env tsx
// Every key a keyboard handler compares is one the shortcut registry lists, so the shortcut sheet shows everything that is bound.
//
// THE BUG THIS PREVENTS. Only the command palette's key was discoverable;
// Escape, the photo viewer's arrows, the run key and the chat's Tab were bound
// and listed nowhere (#4227). A list written once, beside the handlers, goes
// stale the day somebody binds a new key without knowing it exists.
//
// THE RULE. The registry is SHORTCUTS in packages/platform-web/src/shortcuts.ts;
// each entry says which KeyboardEvent keys it `binds`. Any comparison of a
// keyboard event's key or code against a literal, in a screen's source
// (web/src, platform-web, a module's ui/), must name a key some entry binds:
// `e.key === "Escape"`, `ev.code !== "Space"`, `event.key.toLowerCase() === "k"`,
// `"Enter" === e.key`. A key nobody should see in the sheet (a test-only
// hook, a scanner's own terminator) says so on the line or the one above:
// `// key-not-a-shortcut: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the event's own
// property (`e.`, `ev.`, `evt.`, `event.`, `ke.` followed by `.key` or `.code`).
// A bare `key === "then"` in the same tree is a query key or a map key, never
// a keystroke; matching every `key ===` read those as bindings. And `e.code`
// is as often an error's code (`e.code === "stale"`), so a `.code` comparison
// counts only when its value is shaped like a KeyboardEvent.code. Tests are
// out of scope: a test presses keys, it does not bind them.
//
// Its first run found two keys nobody had listed: a comma and Backspace in the
// box that takes a dropdown's choices (ChoicesInput).
//
// PROVEN RED (2026-09-30): an `e.key === "x"` added to the photo viewer's
// handler failed it, naming the file and the line, before "x" was anywhere in
// the registry.
//
//   npx tsx scripts/lint-keys-are-listed.ts   (pnpm lint keys-are-listed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = "packages/platform-web/src/shortcuts.ts";
const ROOTS = ["web/src", "packages/platform-web/src"];
const OPT_OUT = /key-not-a-shortcut:\s*\S/;

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

function files(): string[] {
  const out: string[] = [];
  for (const r of ROOTS) out.push(...walk(r));
  for (const mod of readdirSync("modules")) out.push(...walk(join("modules", mod, "src", "ui")));
  return out;
}

/** Every key an entry binds, as the event would carry it. */
function bound(): Set<string> {
  const src = readFileSync(REGISTRY, "utf8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bbinds:\s*\[([^\]]*)\]/g)) {
    for (const k of m[1]!.matchAll(/["'`]((?:[^"'`\\]|\\.)+)["'`]/g)) keys.add(k[1]!);
  }
  return keys;
}

const EVENT = String.raw`\b(?:e|ev|evt|event|ke)\.(?:key|code)(?:\.toLowerCase\(\)|\.toUpperCase\(\))?`;
const LIT = String.raw`["'\`]((?:[^"'\`\\]|\\.)*)["'\`]`;
const COMPARES = [new RegExp(`${EVENT}\\s*[!=]==?\\s*${LIT}`, "g"), new RegExp(`${LIT}\\s*[!=]==?\\s*${EVENT}`, "g")];
/** `e.code` is also an error's code (`e.code === "stale"`): only a value
 *  shaped like a KeyboardEvent.code is a keystroke. */
const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|Numpad|Arrow|F[0-9]{1,2}$|Space$|Enter$|Escape$|Tab$|Backspace$|Delete$|Home$|End$|Page|Shift|Control|Alt|Meta|Comma$|Period$|Slash$|Minus$|Equal$|Bracket|Semicolon$|Quote$|Backquote$|Backslash$)/;

const keys = bound();
if (keys.size === 0) {
  console.error(`✗ lint:keys-are-listed: read no \`binds\` from ${REGISTRY}; the registry moved or its shape changed`);
  process.exit(1);
}

const out: string[] = [];
let compared = 0;
for (const f of files()) {
  if (f === REGISTRY) continue;
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/\.(key|code)\b/.test(line)) continue;
    for (const re of COMPARES) {
      for (const m of line.matchAll(re)) {
        const key = m[1]!;
        if (/\.code\b/.test(m[0]) && !KEY_CODE.test(key)) continue;
        compared++;
        if (keys.has(key)) continue;
        if (OPT_OUT.test(line) || OPT_OUT.test(lines[i - 1] ?? "")) continue;
        out.push(`  ${f}:${i + 1}  binds "${key}", which no shortcut in ${REGISTRY} lists`);
      }
    }
  }
}

if (out.length) {
  console.error(
    `✗ lint:keys-are-listed: ${out.length} key(s) bound and not on the shortcut sheet:\n${out.join("\n")}\n\n` +
      "Add the key to the shortcut it belongs to (its `binds`, and say where it works), or add a new entry, so " +
      "the ? sheet shows it. A key that is not a shortcut says why on the line: // key-not-a-shortcut: <why>",
  );
  process.exit(1);
}
console.log(`✓ lint:keys-are-listed: ${compared} key comparison(s), every key on the shortcut sheet`);
