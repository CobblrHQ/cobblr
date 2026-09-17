#!/usr/bin/env tsx
// A resolver context field that gates a state has a producer, and a surface test hands the resolver the context the surface builds
//
// THE BUG THIS PREVENTS is a DECLARATION MISTAKEN FOR A MECHANISM: a thing
// that is written down, typed, tested and visibly present, and that nothing
// on the real path ever reaches. The same family as an error branch no
// caller can enter, a guard behind an exit code nobody read, a status the
// tool reports and never verified. Two instances shaped this lint:
//
// `ScanRowStateContext.permitted` existed, gated the `blocked` eligibility
// in `scanRowState`, had a unit test for the state, and nothing in the
// product ever set it: every surface called `scanRowState(row, { tables,
// canInstall, fieldLabel })`, so the blocked state, its sentence and "Ask
// an admin" never rendered anywhere, and a member learned they could not
// file from the 403 (#3073, #3126). The field read as coverage and was not.
// Then the guardrail written for that class failed the same way: the
// cross-surface test handed `scanSessionAction` a hand-written
// `{ canInstall: false }` while the page called it with no context at all,
// so the test was green while the strip said "Install & file 1" over a row
// the card called "Ask an admin" (#3122). Both are one defect: something
// that looks like the real input and is not. The rule below is scan-shaped
// only in its examples; it reads every context a contract resolver takes.
//
// THE RULE, two halves over one scan of the contract:
//   1. For every `export interface <X>Context` in
//      packages/platform-contract/src whose file reads `ctx.<field>` for an
//      OPTIONAL field of it, some non-test file under web/src,
//      packages/platform-web/src, modules/*/src or api/src must PRODUCE
//      that field: write it as an object key (`field:` or shorthand
//      `{ field }`) in a file that names the resolver or the context type
//      (imports it, calls it). A read with no producer fails, naming the
//      resolver file, the field and that no surface sets it.
//   2. A SURFACE test (a web/module-ui test that renders with
//      @testing-library) that uses a contract resolver as the ORACLE for what
//      it rendered (the resolver call sits inside an `expect(...)`) must
//      hand it a context built by a product producer: the context argument,
//      or the declaration of the identifier it names, must call a function
//      imported from a non-test module of its own tree. An inline literal or
//      a hand-declared object fails. A resolver call that FEEDS the render
//      (a component that takes the resolved state as a prop) is the test's
//      fixture, not its oracle, and is not judged. Contract unit tests (the
//      resolver's own) are not surfaces and build their contexts by hand on
//      purpose.
//   No opt-out: a field nobody produces is deleted, and a surface test that
//   cannot reach the producer asks the surface for it.
//
// THE LOOPHOLE, named so nobody takes it at 11pm. Half 2 does not judge a
// contract unit test, because the resolver's own test must build its inputs.
// So the cheap way to make a red run green is to move the assertion into a
// contract unit test, which passes here and loses the cross-surface
// property the rule exists to protect (the row and the strip agreeing for
// the same person). Do not. If no product producer can build the context a
// surface test needs, extend the producer until it can (that is exactly how
// scanViewerContext gained `permittedFor`), or delete the field the test
// wanted, and keep the assertion on the surface.
//
// PROVE IT RED before you trust it green: red on a checkout of 9c8b83eff
// (`permitted` had no producer) and on 4baa59dd0's
// ScanInboxCard.one-label.test.tsx (`c.ctx`, hand-built); green on main
// after #3140. COBBLR_LINT_ROOT=<a checkout> points it at another tree.
//
//   npx tsx scripts/lint-gated-state-has-a-producer.ts   (pnpm run lint:gated-state-has-a-producer)
//   npx tsx scripts/lint-gated-state-has-a-producer.ts --list   every gated field and the file that produces it
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const CONTRACT = join(BASE, "packages/platform-contract/src");
/** Where a producer may live: every tree that calls the contract. */
const PRODUCER_ROOTS = ["web/src", "packages/platform-web/src", "modules", "api/src"].map((r) => join(BASE, r));
/** Where a surface test may live. */
const SURFACE_TEST_ROOTS = ["web/src", "packages/platform-web/src", "modules"].map((r) => join(BASE, r));

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, tests: boolean): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, tests);
    else if (/\.(ts|tsx)$/.test(name) && /\.test\.tsx?$/.test(name) === tests) yield p;
  }
}

const rel = (p: string): string => relative(BASE, p) || p;

// ── The contract's side: which optional context fields a resolver reads ──

interface GatedField {
  file: string;
  line: number;
  context: string;
  field: string;
  /** Names a producer file must mention to count: the context type and the
   *  file's exported functions. */
  names: string[];
}

function gatedFields(file: string, src: string): GatedField[] {
  const out: GatedField[] = [];
  const exported = [...src.matchAll(/^export (?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
  const lines = src.split("\n");
  const ifaceRe = /^export interface ([A-Za-z_$][\w$]*Context)\b[^{]*\{/gm;
  for (const m of src.matchAll(ifaceRe)) {
    const name = m[1]!;
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    // Optional fields: `field?:` at the start of a line, outside comments.
    const fields = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\?\s*:/gm)].map((f) => f[1]!);
    for (const field of fields) {
      const readRe = new RegExp(`\\bctx\\??\\.${field}\\b`);
      const at = lines.findIndex((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && readRe.test(l));
      if (at < 0) continue;
      out.push({ file, line: at + 1, context: name, field, names: [name, ...exported] });
    }
  }
  return out;
}

// ── The product's side: who writes those keys ──

interface ProducerFile {
  file: string;
  src: string;
}

function producesKey(src: string, field: string): boolean {
  // `field:` as an object key (not `field?:`, not a `?.field` read), or the
  // shorthand `{ field }` / `, field }` / `, field,`.
  const key = new RegExp(`(?<![\\w$?.])${field}\\s*:(?!:)`);
  const shorthand = new RegExp(`[{,]\\s*${field}\\s*[,}]`);
  return key.test(src) || shorthand.test(src);
}

function mentionsAny(src: string, names: readonly string[]): boolean {
  return names.some((n) => new RegExp(`\\b${n}\\b`).test(src));
}

// ── The surface tests: what they hand the resolver ──

/** The resolver's context is its LAST parameter (`ctx: <X>Context`). */
function ctxTakingResolvers(file: string, src: string): string[] {
  return [...src.matchAll(/^export function ([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)]
    .filter((m) => /\bctx\??\s*:\s*[A-Za-z_$][\w$]*Context\b/.test(m[2]!))
    .map((m) => m[1]!);
}

/** The argument list of the call starting at `open` (the index of "("),
 *  split at top-level commas. */
function callArgs(src: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let i = open + 1;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += src[i + 1] ?? "";
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return { args, end: i };
}

function checkSurfaceTest(file: string, src: string, resolvers: readonly string[]): Violation[] {
  const out: Violation[] = [];
  if (!/from\s+["']@testing-library\//.test(src)) return out;
  // Names imported from a non-test module of the test's own tree: the
  // producers a context may come from.
  const producers = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.\.?\/[^"']*)["']/g)) {
    if (/\.test$/.test(m[2]!)) continue;
    for (const n of m[1]!.split(",")) {
      const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) producers.add(name);
    }
  }
  const callsProducer = (expr: string): boolean => [...producers].some((p) => new RegExp(`\\b${p}\\s*\\(`).test(expr));
  const declOf = (id: string): string | null => {
    const m = src.match(new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=]*)?=([^;]*)`));
    return m ? m[1]! : null;
  };
  const builtByProducer = (expr: string): boolean => {
    if (callsProducer(expr)) return true;
    // `viewer()` or `viewer`: follow the identifier to its declaration once.
    const id = expr.match(/^([A-Za-z_$][\w$]*)\s*(?:\(\s*\))?$/)?.[1];
    if (!id) return false;
    const decl = declOf(id);
    return !!decl && callsProducer(decl);
  };
  // The oracle positions: everything inside an `expect(...)` argument list.
  const oracle: Array<[number, number]> = [];
  for (const m of src.matchAll(/(?<![\w$.])expect\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    oracle.push([open, callArgs(src, open).end]);
  }
  const isOracle = (at: number): boolean => oracle.some(([a, b]) => at > a && at < b);
  const lines = src.split("\n");
  for (const name of resolvers) {
    const callRe = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
    for (const m of src.matchAll(callRe)) {
      if (!isOracle(m.index!)) continue;
      const open = m.index! + m[0].length - 1;
      const { args } = callArgs(src, open);
      if (args.length < 2) continue;
      const ctx = args[args.length - 1]!;
      if (builtByProducer(ctx)) continue;
      const line = src.slice(0, m.index!).split("\n").length;
      const shown = lines[line - 1]?.trim() ?? "";
      out.push({
        file,
        line,
        what: `hands ${name}() a context the surface never builds (${ctx.length > 40 ? ctx.slice(0, 40) + "…" : ctx}); take it from the producer the surface reads, and if no producer can build this shape, extend the producer rather than moving the assertion into a contract unit test (that passes here and loses the cross-surface property). Line: ${shown.slice(0, 80)}`,
      });
    }
  }
  return out;
}

// ── Run ──

const violations: Violation[] = [];
const gated: GatedField[] = [];
const resolvers: string[] = [];
for (const file of walk(CONTRACT, false)) {
  const src = readFileSync(file, "utf8");
  gated.push(...gatedFields(file, src));
  resolvers.push(...ctxTakingResolvers(file, src));
}

const producerFiles: ProducerFile[] = [];
for (const root of PRODUCER_ROOTS) for (const file of walk(root, false)) producerFiles.push({ file, src: readFileSync(file, "utf8") });

const list = process.argv.includes("--list");
for (const g of gated) {
  // The file that names the context type itself is the honest producer to
  // report; a file that merely calls a resolver and writes the key is still
  // one for the verdict.
  const producer =
    producerFiles.find((p) => producesKey(p.src, g.field) && mentionsAny(p.src, [g.context])) ??
    producerFiles.find((p) => producesKey(p.src, g.field) && mentionsAny(p.src, g.names));
  if (list) console.log(`  ${g.context}.${g.field}  (${rel(g.file)}:${g.line})  <- ${producer ? rel(producer.file) : "NOBODY"}`);
  if (producer) continue;
  violations.push({
    file: rel(g.file),
    line: g.line,
    what: `${g.context}.${g.field} gates a state in ${basename(g.file)} and no surface sets it (no non-test file that names ${g.names[0]} or its resolvers writes \`${g.field}:\`); the state it gates can never render. Produce it, or delete it.`,
  });
}

if (resolvers.length) {
  for (const root of SURFACE_TEST_ROOTS) {
    for (const file of walk(root, true)) {
      violations.push(...checkSurfaceTest(rel(file), readFileSync(file, "utf8"), resolvers));
    }
  }
}

if (violations.length) {
  console.error(`lint:gated-state-has-a-producer - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A field nothing produces is coverage that is not there: produce it from the surface, or delete it. A surface test takes its context from the producer the surface reads, never a hand-built one; a shape no producer can build yet is a reason to extend the producer, not to relocate the assertion.");
  process.exit(1);
}
console.log(`lint:gated-state-has-a-producer OK (${gated.length} gated fields produced; ${resolvers.length} resolvers)`);
