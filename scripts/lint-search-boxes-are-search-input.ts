#!/usr/bin/env tsx
// A search box is a SearchInput (packages/platform-web), which clears with an × and Esc; a raw input that searches or filters is refused.
//
// THE BUG THIS PREVENTS. search boxes were written by hand, twenty-odd of them, and none could be emptied without selecting its text (#4014, 2026-09-29)
//
// THE RULE. Every `<input … />` element in the web app, the modules' UIs and
// platform-web is read whole (its attributes can span lines). It FAILS when
// it is `type="search"`, or its placeholder or aria-label starts with
// "search", "filter" or "find" (any case, a template literal included): that
// is a search box, and it is <SearchInput> instead. It PASSES everywhere else,
// and in SearchInput.tsx, which owns the one raw input. A genuine exception
// says so inside the element or on the line above it:
// `// search-input-ok: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The select-like Combobox
// (web/src/components/Combobox.tsx) filters its options as you type but
// shows the chosen value in the box, with its own clear for the selection:
// it is a select, not a search box, and its placeholder is the caller's
// ("Search connections…" came through a prop), so the rule reads the input
// element's own attributes, never a component's props. The assistant's
// "Ask something" box submits a question; it does not start with a search
// word and is not a search.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-search-boxes-are-search-input.ts   (pnpm lint search-boxes-are-search-input)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const OWNER = "packages/platform-web/src/SearchInput.tsx";
const SEARCHY = /^(?:search|filter|find)\b/i;

/** A value an attribute holds as written: "…", {"…"} or {`…`}. */
function literal(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/^\{?\s*["'`]([^"'`]*)/);
  return m ? (m[1] ?? "") : null;
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file.replace(/\\/g, "/").endsWith(OWNER)) return out;
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const end = src.indexOf("/>", m.index);
    if (end < 0) continue;
    const el = src.slice(m.index, end);
    const lineNo = src.slice(0, m.index).split("\n").length;
    const before = src.split("\n")[lineNo - 2] ?? "";
    if (/search-input-ok:\s*\S/.test(el) || /search-input-ok:\s*\S/.test(before)) continue;
    const attr = (name: string) => el.match(new RegExp(`\\b${name}=(\\{[^}]*\\}|"[^"]*")`))?.[1];
    const type = literal(attr("type"));
    const placeholder = literal(attr("placeholder"));
    const label = literal(attr("aria-label"));
    const why =
      type === "search"
        ? 'type="search"'
        : placeholder && SEARCHY.test(placeholder.trim())
          ? `placeholder "${placeholder}"`
          : label && SEARCHY.test(label.trim())
            ? `aria-label "${label}"`
            : null;
    if (why) out.push({ file, line: lineNo, what: `a raw search box (${why}): use <SearchInput> from @cobblr/platform-web` });
  }
  return out;
}

const violations: Violation[] = [];
if (process.argv[1]?.endsWith("lint-search-boxes-are-search-input.ts")) for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length && process.argv[1]?.endsWith("lint-search-boxes-are-search-input.ts")) {
  console.error(`lint:search-boxes-are-search-input - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use <SearchInput value onChange placeholder aria-label /> from @cobblr/platform-web");
  process.exit(1);
}
if (process.argv[1]?.endsWith("lint-search-boxes-are-search-input.ts")) console.log(`lint:search-boxes-are-search-input OK`);
