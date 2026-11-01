#!/usr/bin/env tsx
// A walk never finds a button or link by exact text that the element's own aria-label replaces as its accessible name.
//
// THE BUG THIS PREVENTS. c54250d44c (2026-10-27, #8670) named each module
// toggle "Disable <module>" for screen readers, with an aria-label beside the
// button's visible "disable". An aria-label is the accessible name, so
// Playwright's getByRole("button", { name: "disable", exact: true }) stopped
// finding the button. The workshop walk asked for exactly that, and failed
// 14 steps on every device for five days while the product was right (#9055).
//
// THE RULE. Every getByRole("button" | "link", { name: "<literal>", exact:
// true }) in e2e/**/*.mjs is read against the product's UI source (web/src,
// packages/platform-web/src, modules/*/src/ui). An element there that carries
// a literal aria-label AND inline text equal to the walk's name, where the
// label is not that text, fails: the walk names the text, the browser names
// the label. Find the control by its label (or a pattern of it, /^Disable /),
// or scope it by a testid, or give the element the label the walk says.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A plain "the walk's name
// is somewhere in the source" check would have PASSED #8670: the word
// "disable" stayed in the file, as the button's text. And half of what walks
// look for is data they seed, in no source file at all (the sentence lint
// measured it, 721 of 1430). So the rule names only the one shape that breaks
// silently: text and a different aria-label on the same element, where no
// other button or link shows that text unlabelled. The first run flagged a
// walk's exact "Remove" against a template form's labelled "Remove <field>"
// while the walk meant the place page's photo button, which has no label and
// says Remove: a shared word, not a lost name, so it does not count. A label
// built from a template counts by its literal prefix ("Disable " for
// `Disable ${m.displayName}`), which is never the bare text. JSON walk specs
// (e2e/walks) select by text, not by role name, and are not read here.
//
// PROVEN RED on the workshop walk as it stood before #9055's fix: its exact
// "disable" against ModulePickerModal's aria-labelled toggle.
//
//   npx tsx scripts/lint-a-walk-never-finds-a-control-by-text-its-aria-label-replaced.ts   (pnpm lint a-walk-never-finds-a-control-by-text-its-aria-label-replaced)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";

const WALK_ROOTS = ["e2e"];
const UI_ROOTS = ["web/src", "packages/platform-web/src", ...readdirSync("modules").map((m) => join("modules", m, "src", "ui"))];

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, ext: RegExp): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, ext);
    else if (ext.test(name) && !/\.test\.[jt]sx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const lineAt = (src: string, index: number) => src.slice(0, index).split("\n").length;

/** Every exact role name a walk asks for: name -> where. */
export function walkNames(file: string, src: string): Array<{ name: string; file: string; line: number }> {
  const out: Array<{ name: string; file: string; line: number }> = [];
  const re = /getByRole\(\s*["'](button|link)["']\s*,\s*\{([^}]*)\}/g;
  for (const m of src.matchAll(re)) {
    const opts = m[2] ?? "";
    if (!/\bexact:\s*true\b/.test(opts)) continue;
    const name = /\bname:\s*"([^"\\]+)"/.exec(opts)?.[1] ?? /\bname:\s*'([^'\\]+)'/.exec(opts)?.[1];
    if (name) out.push({ name, file, line: lineAt(src, m.index ?? 0) });
  }
  return out;
}

/** Elements with a literal aria-label (or a template's literal prefix) and
 *  plain inline text: what the browser names them, and what the eye reads. */
export function labelledTexts(file: string, src: string): Array<{ text: string; label: string; file: string; line: number }> {
  const out: Array<{ text: string; label: string; file: string; line: number }> = [];
  const re = /aria-label=(?:"([^"]*)"|\{`([^`$]*)(?:\$\{|`))/g;
  for (const m of src.matchAll(re)) {
    const label = m[1] ?? m[2] ?? "";
    const start = m.index ?? 0;
    // The tag must be a button or a link: the nearest '<' before the label.
    const open = src.lastIndexOf("<", start);
    if (!/^<(button|a|Button|Link)\b/.test(src.slice(open, open + 8))) continue;
    // The end of the opening tag: the first '>' outside braces and quotes.
    let depth = 0;
    let quote: string | null = null;
    let i = start;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    if (src[i - 1] === "/") continue; // self-closing: no text
    const rest = src.slice(i + 1);
    const text = /^\s*([^<{}\n][^<{}]*?)\s*</.exec(rest)?.[1]?.trim();
    if (text && text !== label) out.push({ text, label, file, line: lineAt(src, start) });
  }
  return out;
}

/** Texts of buttons and links with NO aria-label: the name the browser
 *  gives them is their text, so a walk may find them by it. */
export function unlabelledTexts(src: string): Set<string> {
  const out = new Set<string>();
  const re = /<(button|a|Button|Link)\b/g;
  for (const m of src.matchAll(re)) {
    let depth = 0;
    let quote: string | null = null;
    let i = (m.index ?? 0) + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index ?? 0, i);
    if (/aria-label(ledby)?=/.test(tag) || src[i - 1] === "/") continue;
    const text = /^\s*([^<{}\n][^<{}]*?)\s*</.exec(src.slice(i + 1))?.[1]?.trim();
    if (text) out.add(text);
  }
  return out;
}

export function check(walks: ReturnType<typeof walkNames>, labelled: ReturnType<typeof labelledTexts>, unlabelled: ReadonlySet<string> = new Set()): Violation[] {
  const byText = new Map<string, (typeof labelled)[number]>();
  for (const l of labelled) if (!byText.has(l.text)) byText.set(l.text, l);
  const out: Violation[] = [];
  for (const w of walks) {
    const hit = byText.get(w.name);
    // Another control shows the same text with no label ("Remove" is on many
    // pages): the walk may well mean that one, so the name is not proven gone.
    if (!hit || unlabelled.has(w.name)) continue;
    out.push({ file: w.file, line: w.line, what: `finds a control by exact name "${w.name}", but ${hit.file}:${hit.line} labels it "${hit.label}${hit.label.endsWith(" ") ? "…" : ""}" for screen readers, which is the name the browser gives it` });
  }
  return out;
}

if (process.argv[1]?.endsWith("lint-a-walk-never-finds-a-control-by-text-its-aria-label-replaced.ts")) {
  const walks = WALK_ROOTS.flatMap((r) => [...walk(r, /\.mjs$/)]).flatMap((f) => walkNames(f, readFileSync(f, "utf8")));
  const uiFiles = UI_ROOTS.flatMap((r) => [...walk(r, /\.tsx$/)]).map((f) => ({ f, src: readFileSync(f, "utf8") }));
  const labelled = uiFiles.flatMap(({ f, src }) => labelledTexts(f, src));
  const unlabelled = new Set(uiFiles.flatMap(({ src }) => [...unlabelledTexts(src)]));
  const violations = check(walks, labelled, unlabelled);
  if (violations.length) {
    console.error(`lint:a-walk-never-finds-a-control-by-text-its-aria-label-replaced - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Find the control by its label (or a pattern of it, /^Disable /), or scope it by a testid; or give the element the label the walk says.");
    process.exit(1);
  }
  console.log(`lint:a-walk-never-finds-a-control-by-text-its-aria-label-replaced OK (${walks.length} exact role names against ${labelled.length} labelled controls)`);
}
