#!/usr/bin/env tsx
// Every file the web image's build compiles imports only files its Dockerfile copies into the build.
//
// THE BUG THIS PREVENTS. A web test started importing
// `../../../scripts/lib/load-factor.mjs` (a per-test timeout worn at the box's
// load). The web image copies web/, the packages and the modules it needs, and
// no scripts/, so `tsc -b` inside the image could not find the file and every
// core-web build on main went red (2026-09-23). Nothing before the image build
// could see it: on a developer's checkout and in CI's typecheck the whole repo
// is there, so the import resolves. A file the build ASSUMES is there versus a
// file it COPIES is the same class as #3388 (a COPY of a path the public export
// did not ship).
//
// THE RULE. Read what the build actually has, and what it actually compiles:
//   - the build context is the COPY sources of the builder stage of
//     docker/web.Dockerfile up to the step that runs the build (the shared
//     parser in scripts/lib/dockerfile-copy.ts, not a hand-kept list);
//   - the compiled files are the `include` roots of the tsconfigs web's
//     `tsc -b` builds (web/tsconfig.json's references), followed through every
//     relative import, and through every `@cobblr/*` workspace import to the
//     file that package's `exports` names.
// A relative import that resolves outside the copied paths fails, and so does a
// workspace package the build imports but the image never copies. Bare
// third-party imports come from node_modules, which the image installs, and
// are out of scope. There is no opt-out: an import the image cannot resolve
// fails the build whatever a comment says.
//
// PROVE IT RED: on main at 5c4b48ad0 it names
// web/src/pages/WhatsOnHand.refreshes-after-action.test.tsx.
//
//   npx tsx scripts/lint-web-image-reads-what-it-copies.ts   (pnpm run lint:web-image-reads-what-it-copies)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { copySources } from "./lib/dockerfile-copy.js";
import { stripComments } from "./lib/source-scan.js";

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const DOCKERFILE = "docker/web.Dockerfile";
const WEB = "web";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const abs = (p: string): string => join(ROOT, p);

/** The builder stage's COPY sources, up to and including the step that runs
 *  the web build: what exists in /app when `tsc -b` runs. */
export function buildContext(dockerfile: string): string[] {
  const out: string[] = [];
  let inBuilder = false;
  for (const line of dockerfile.split("\n")) {
    if (/^\s*FROM\s/i.test(line)) {
      if (inBuilder) break;
      inBuilder = true;
      continue;
    }
    if (!inBuilder) continue;
    out.push(...copySources(line).map((s) => s.replace(/^\.\//, "").replace(/\/$/, "")));
    if (/^\s*RUN\b.*\brun build\b/.test(line)) break;
  }
  return out;
}

function readJson<T>(p: string): T {
  // tsconfig files may carry comments; the shared scanner knows strings.
  return JSON.parse(stripComments(readFileSync(abs(p), "utf8"))) as T;
}

function* walkDir(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(abs(dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = `${dir}/${name}`;
    if (statSync(abs(p)).isDirectory()) yield* walkDir(p);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) yield p;
  }
}

/** The files web's `tsc -b` compiles directly: each referenced tsconfig's
 *  `include`, a directory walked or a file taken as it is. */
function compiledRoots(): string[] {
  const top = readJson<{ references?: { path: string }[] }>(`${WEB}/tsconfig.json`);
  const configs = (top.references ?? []).map((r) => normalize(`${WEB}/${r.path}`).split("\\").join("/"));
  const out: string[] = [];
  for (const cfg of configs) {
    const file = cfg.endsWith(".json") ? cfg : `${cfg}/tsconfig.json`;
    const { include = [] } = readJson<{ include?: string[] }>(file);
    for (const inc of include) {
      const p = `${dirname(file)}/${inc}`.replace(/\/\*\*.*$/, "");
      if (!existsSync(abs(p))) continue;
      if (statSync(abs(p)).isDirectory()) out.push(...walkDir(p));
      else out.push(p);
    }
  }
  return out;
}

/** `@cobblr/<name>` → its directory, for every workspace package. */
function workspacePackages(): Map<string, string> {
  const out = new Map<string, string>();
  for (const parent of ["packages", "modules"]) {
    let names: string[] = [];
    try {
      names = readdirSync(abs(parent));
    } catch {
      continue;
    }
    for (const n of names) {
      const pj = `${parent}/${n}/package.json`;
      if (!existsSync(abs(pj))) continue;
      const { name } = readJson<{ name?: string }>(pj);
      if (name) out.set(name, `${parent}/${n}`);
    }
  }
  return out;
}

type ExportTarget = string | { [cond: string]: ExportTarget } | null;

function pickTarget(t: ExportTarget): string | null {
  if (typeof t === "string") return t;
  if (!t) return null;
  for (const c of ["types", "import", "default", "browser", "node"]) {
    const v = t[c];
    if (v !== undefined) {
      const hit = pickTarget(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** The file a `@cobblr/<pkg>[/sub]` import lands on, through the package's
 *  `exports` (or `main`), or null when the package does not say. */
function resolvePackageImport(pkgDir: string, sub: string): string | null {
  const pj = readJson<{ exports?: Record<string, ExportTarget> | string; main?: string; types?: string }>(`${pkgDir}/package.json`);
  const key = sub ? `./${sub}` : ".";
  let target: string | null = null;
  if (typeof pj.exports === "string") target = key === "." ? pj.exports : null;
  else if (pj.exports) {
    const t = pj.exports[key];
    if (t !== undefined) target = pickTarget(t);
    else {
      for (const [k, v] of Object.entries(pj.exports)) {
        if (!k.includes("*")) continue;
        const [pre, post] = k.split("*") as [string, string];
        if (key.startsWith(pre) && key.endsWith(post)) {
          const mid = key.slice(pre.length, key.length - post.length);
          const pt = pickTarget(v);
          if (pt) target = pt.replace("*", mid);
          break;
        }
      }
    }
  }
  if (!target && key === ".") target = pj.types ?? pj.main ?? null;
  return target ? normalize(`${pkgDir}/${target}`).split("\\").join("/") : null;
}

const CODE_EXT = [".ts", ".tsx", ".mts", ".d.mts", ".d.ts", ".js", ".mjs", ".jsx"];

/** A relative specifier as a file on disk, the way the bundler resolver finds
 *  it: as written, with a code extension, a `.js` written for its `.ts`, or a
 *  directory's index. Null when nothing exists (a path outside the repo, or a
 *  typo tsc will name for itself). */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = normalize(`${dirname(fromFile)}/${spec}`).split("\\").join("/");
  const tries = [base, ...CODE_EXT.map((e) => base + e)];
  const m = /^(.*)\.(m?js|jsx)$/.exec(base);
  if (m) tries.push(...[".ts", ".tsx", ".mts", ".d.mts"].map((e) => m[1] + e));
  tries.push(...["index.ts", "index.tsx", "index.js"].map((i) => `${base}/${i}`));
  for (const t of tries) if (existsSync(abs(t)) && statSync(abs(t)).isFile()) return t;
  return null;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s+\*\s+from\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Every import specifier in a file, with its line. Comments are blanked
 *  first (the shared scanner, which keeps line numbers) so an example in a
 *  comment is not an import. */
export function importsOf(src: string): { spec: string; line: number }[] {
  const code = stripComments(src);
  const out: { spec: string; line: number }[] = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    const line = code.slice(0, m.index).split("\n").length;
    out.push({ spec: m[1]!, line });
  }
  return out;
}

export function inContext(path: string, context: string[]): boolean {
  return context.some((c) => path === c || path.startsWith(`${c}/`));
}

function main(): void {
  const context = buildContext(readFileSync(abs(DOCKERFILE), "utf8"));
  const pkgs = workspacePackages();
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const queue = compiledRoots();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|mts|cts|js|mjs|jsx)$/.test(file)) continue;
    for (const { spec, line } of importsOf(readFileSync(abs(file), "utf8"))) {
      let target: string | null = null;
      if (spec.startsWith(".")) {
        target = resolveRelative(file, spec);
        if (!target) {
          const base = normalize(`${dirname(file)}/${spec}`).split("\\").join("/");
          if (!inContext(base, context)) violations.push({ file, line, what: `imports ${spec}, outside everything ${DOCKERFILE} copies` });
          continue;
        }
      } else {
        const m = /^(@cobblr\/[^/]+)(?:\/(.*))?$/.exec(spec);
        if (!m) continue;
        const dir = pkgs.get(m[1]!);
        if (!dir) continue;
        if (!inContext(dir, context)) {
          violations.push({ file, line, what: `imports ${spec}, and ${DOCKERFILE} never copies ${dir}` });
          continue;
        }
        target = resolvePackageImport(dir, m[2] ?? "");
        if (!target || !existsSync(abs(target))) continue;
      }
      if (!inContext(target, context)) {
        violations.push({ file, line, what: `imports ${spec} (${target}), which ${DOCKERFILE} does not copy into the build` });
        continue;
      }
      if (!/\.d\.m?ts$/.test(target)) queue.push(target);
    }
  }

  if (violations.length) {
    console.error(`lint:web-image-reads-what-it-copies - ${violations.length} import(s) the web image's build cannot resolve:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error(`
The whole repo is there on a checkout and in CI's typecheck, so this resolves
everywhere except inside the image, where tsc -b fails and core-web stops
building. Copy the file into the builder stage of ${DOCKERFILE}, or import
something the image already has.`);
    process.exit(1);
  }
  console.log(`lint:web-image-reads-what-it-copies OK (${seen.size} files the web build compiles, ${context.length} COPY sources)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("lint-web-image-reads-what-it-copies.ts")) main();

