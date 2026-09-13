#!/usr/bin/env tsx
// A number input hands its text to the record only as a number: through valueFromInput (a custom-field editor) or a numeric parse, never e.target.value as it came.
//
// THE BUG THIS PREVENTS. The New item form stored a grocery's Good for (days) as the string "10"; the lot rule read typeof === "number", dated no lot, and a check-off the shopping row had promised a date for left last week's use-by standing (2026-09-13, #2837).
//
// THE RULE. Every `<input>` whose `type` is (or can be) "number" is read for
// the handlers on it: `onChange`, `onInput`, `onBlur`. A handler that reads
// the input's text (`.target.value`, `.currentTarget.value`) must convert it
// before it leaves the component: `valueFromInput(` (the shared rule for a
// custom-field editor), `Number(`, `parseFloat(`, `parseInt(` or
// `valueAsNumber`. A handler that only parks the text in a local draft
// (`setDraft(`, `setXDraft(`, `setXText(`) passes, since a draft is text by
// nature and something else converts it. A handler that is a named function
// is read where it is defined, and so is a function defined in the same
// file that the text is passed to (`onCommit(parse(e.target.value))`).
// `type={expr}` resolves one level: an
// identifier is looked up in the same file, and if its initializer mentions
// "number" the input counts as a number input. A genuine exception opts out
// with `// NUMBER-INPUT-TEXT: <why>` on the line above the `<input`.
//
// What it does NOT do: judge a text input that happens to hold digits (a
// barcode, a phone number), or a handler that stores into a form library
// which converts on its own (there is none here; if one arrives, opt out
// with the reason).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-number-input-commits-a-number.ts   (pnpm run lint:number-input-commits-a-number)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["packages/platform-web/src", "web/src", "modules"];

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

/** The initializer text of `const|let NAME = …;` in this file, or null. */
function initializerOf(src: string, name: string): string | null {
  const m = new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=]*=\\s*([^;]+);`).exec(src);
  return m?.[1] ?? null;
}

/** The body of `function NAME(` or `const NAME = (…) =>` in this file, by
 *  brace matching from its first `{`, or null when it is not defined here. */
function functionBodyOf(src: string, name: string): string | null {
  const m = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]+)?=>)`).exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

const READS_TEXT = /\.(?:target|currentTarget)\.value\b/;
const CONVERTS = /valueFromInput\(|\bNumber\(|parseFloat\(|parseInt\(|valueAsNumber/;
/** A handler that only parks the text in component state: every `.value`
 *  read sits inside a `set<Something>(…)` call (a React state setter). The
 *  text is then a draft the submit converts; what this lint refuses is text
 *  handed straight out of the component, to a prop callback or a request. */
function onlyStores(handler: string): boolean {
  let out = "";
  let i = 0;
  while (i < handler.length) {
    const m = /\bset[A-Z]\w*\(/.exec(handler.slice(i));
    if (!m) {
      out += handler.slice(i);
      break;
    }
    out += handler.slice(i, i + m.index);
    let j = i + m.index + m[0].length;
    let depth = 1;
    while (j < handler.length && depth > 0) {
      if (handler[j] === "(") depth++;
      else if (handler[j] === ")") depth--;
      j++;
    }
    i = j;
  }
  return !READS_TEXT.test(out);
}

/** The text is passed to a function defined in this file whose body
 *  converts it (`onCommit(parse(e.target.value))`, with `parse` doing the
 *  `Number(`): one hop, no further. */
function convertsThroughLocal(src: string, handler: string): boolean {
  const calls = handler.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*e\.(?:target|currentTarget)\.value\b/g);
  for (const c of calls) {
    const body = functionBodyOf(src, c[1] ?? "");
    if (body && CONVERTS.test(body)) return true;
  }
  return false;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // The whole tag: `>` closes it only outside `{…}`, since a handler's
    // arrow (`=>`) sits inside braces.
    let depth = 0;
    let close = -1;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    const tag = src.slice(m.index, close + 1);
    const before = src.slice(0, m.index);
    const line = before.split("\n").length;
    const prevLine = before.split("\n").at(-2) ?? "";
    if (/NUMBER-INPUT-TEXT:/.test(prevLine)) continue;
    const typeAttr = /\btype=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag);
    if (!typeAttr) continue;
    let typeText = typeAttr[1] ?? typeAttr[2] ?? "";
    if (typeAttr[2] && /^[A-Za-z_$][\w$]*$/.test(typeText.trim())) typeText = initializerOf(src, typeText.trim()) ?? typeText;
    if (!/\bnumber\b/.test(typeText)) continue;
    numberInputs++;
    for (const attr of ["onChange", "onInput", "onBlur"]) {
      const h = new RegExp(`\\b${attr}=\\{`).exec(tag);
      if (!h) continue;
      // The handler expression: brace-match from the `{` after `=`.
      const start = h.index + h[0].length - 1;
      let depth = 0;
      let end = start;
      for (let i = start; i < tag.length; i++) {
        if (tag[i] === "{") depth++;
        else if (tag[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      let handler = tag.slice(start + 1, end).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(handler)) handler = functionBodyOf(src, handler) ?? handler;
      if (!READS_TEXT.test(handler)) continue;
      if (CONVERTS.test(handler)) continue;
      if (onlyStores(handler)) continue;
      if (convertsThroughLocal(src, handler)) continue;
      out.push({ file, line, what: `<input type=number> ${attr} hands e.target.value on as text` });
    }
  }
  return out;
}

const violations: Violation[] = [];
let numberInputs = 0;
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:number-input-commits-a-number - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Route the text through valueFromInput(def.type, text) in a field editor, or Number()/parseFloat()/valueAsNumber where the input is a native number; keep the raw text only in a local draft state.");
  process.exit(1);
}
console.log(`lint:number-input-commits-a-number OK: ${numberInputs} number input(s), every one converts its text`);
