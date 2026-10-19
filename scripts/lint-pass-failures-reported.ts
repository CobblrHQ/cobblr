#!/usr/bin/env tsx
// A heal, reconcile or sweep pass records every failure it catches.
//
// THE BUG THIS PREVENTS. #4937: "a field a module adds later reaches
// workspaces that have it" passed only on a retry. The contributed-fields
// reconcile catches each module's failure, as the self-heal rule requires
// (one bad module must never stop boot), logged one line, and returned
// exactly as if nothing had happened. The test could only say "the field
// did not arrive", and nobody could say why: the log line went with the run.
//
// THE RULE. A catch clause inside a pass calls notePassFailure (the kernel's
// report, platform/pass-failures.ts; platform().health.notePassFailure from a
// module), or rethrows, or carries `pass-catch: <why>` in the catch or on the
// line above it. A log line alone does not pass: that is the catch that hid
// #4937. The report keeps the failure for /healthz, /readyz and tests.
//
// WHAT A PASS IS, DISCOVERED, NOT LISTED: every function the boot times in
// api/src/index.ts (`T("<label>", fn(...))`) or registers in
// api/src/platform/boot/ (#7387), every callback handed to
// `sweeps.register` or `registerHealPass`, and, transitively, every function
// in the same file those call by name (a heal's visit is usually a one-line
// call to a `heal…In` function beside it).
//
// THE BOUNDARY. Only `catch` clauses: a promise's `.catch(() => {})` is not
// judged (in a pass it is a release or a best-effort cleanup, never the
// workspace's own work). Only same-file calls are followed: a helper in
// another file that catches is its own caller's business, and following
// imports would judge shared code that is not a pass.
//
//   npx tsx scripts/lint-pass-failures-reported.ts   (pnpm lint pass-failures-reported)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { bootPassRefs } from "./lib/boot-passes.ts";

const ROOTS = ["api/src", "modules"];
const REGISTER = /(^|\.)(sweeps\.register|registerHealPass)$/;
/** Boot steps the boot times that are not passes over workspaces: loading
 *  and mounting code, and printing what the boot found. A module that fails
 *  to load is reported by the module registry, not by a heal. */
const NOT_PASSES = new Map<string, string>([
  ["loadAllModules", "loads module code; a module that will not load is absent from the registry"],
  ["loadAllSandboxedModules", "loads sandboxed module code"],
  ["syncManifestRegistries", "copies manifests into registries"],
  ["syncInstalledModules", "reads the installed-modules file"],
  ["mountModules", "mounts routers"],
  ["refreshScanUrlManifests", "loads scan resolvers; built-ins stand when operator rows cannot be read"],
  ["logAnnounceRouting", "prints a boot notice"],
]);

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
    if (name === "node_modules" || name === "dist" || name === "ui" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) yield p;
  }
}

const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);

/** The functions the boot runs as passes, by name: index.ts's `T("label", fn(...))`
 *  and the registry's descriptors (scripts/lib/boot-passes.ts). */
function bootPassNames(): Set<string> {
  return new Set(bootPassRefs(".").map((p) => p.fn).filter((fn) => !NOT_PASSES.has(fn)));
}

/** Named functions declared at any depth in a file: declarations and
 *  `const x = () => …` / `function` expressions. */
function namedFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const v = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.set(n.name.text, n);
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) out.set(n.name.text, n.initializer);
    ts.forEachChild(n, v);
  };
  v(sf);
  return out;
}

function check(file: string, src: string, boot: Set<string>): Violation[] {
  if (!/catch\s*\(|catch\s*\{/.test(src)) return [];
  const sf = parse(file, src);
  const fns = namedFunctions(sf);
  const roots: ts.Node[] = [];
  if (file.startsWith("api/src/")) for (const [name, node] of fns) if (boot.has(name)) roots.push(node);
  const findRegister = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && REGISTER.test(n.expression.getText(sf))) for (const a of n.arguments) roots.push(a);
    ts.forEachChild(n, findRegister);
  };
  findRegister(sf);
  if (!roots.length) return [];

  // Same-file callees, to a fixed point.
  const inPass = new Set<ts.Node>(roots);
  const queue = [...roots];
  while (queue.length) {
    const r = queue.pop()!;
    const v = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const callee = fns.get(n.expression.text);
        if (callee && !inPass.has(callee)) {
          inPass.add(callee);
          queue.push(callee);
        }
      }
      ts.forEachChild(n, v);
    };
    v(r);
  }

  const out: Violation[] = [];
  const seen = new Set<ts.CatchClause>();
  const lines = src.split("\n");
  for (const r of inPass) {
    const v = (n: ts.Node): void => {
      if (ts.isCatchClause(n) && !seen.has(n)) {
        seen.add(n);
        const body = n.block.getText(sf);
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
        const reasoned = /pass-catch: \S/.test(body) || /pass-catch: \S/.test(lines[line - 1] ?? "") || /pass-catch: \S/.test(lines[line] ?? "");
        let rethrows = false;
        const t = (m: ts.Node): void => {
          if (ts.isThrowStatement(m)) rethrows = true;
          if (!ts.isFunctionLike(m)) ts.forEachChild(m, t);
        };
        t(n.block);
        if (!reasoned && !rethrows && !/\bnotePassFailure\(/.test(body)) {
          out.push({ file, line: line + 1, what: n.block.statements.length === 0 ? "an empty catch in a pass" : "a catch in a pass that does not record what it caught" });
        }
      }
      ts.forEachChild(n, v);
    };
    v(r);
  }
  return out;
}

const boot = bootPassNames();
const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8"), boot));
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (violations.length) {
  console.error(`lint:pass-failures-reported - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(`
  A pass catches so one workspace or module never stops the rest; what it caught must
  still be reported, or "nothing happened" and "it failed" read the same (#4937).
  Fix: call notePassFailure(pass, scope, err) (from api/src/platform/pass-failures.ts;
  platform().health.notePassFailure in a module), rethrow, or say why neither fits
  with // pass-catch: <why>.`);
  process.exit(1);
}
console.log(`lint:pass-failures-reported OK`);
