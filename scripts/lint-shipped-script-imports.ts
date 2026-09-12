#!/usr/bin/env tsx
// Every relative import of a script the public export ships must itself be
// shipped, checked before push rather than by the CI export gate.
//
// THE BUG THIS PREVENTS. The public export is a per-file allowlist
// (scripts/publish/manifests/core.json). `scripts/lint-*.ts` ships by glob;
// a helper it pulls in from scripts/lib/ ships only when listed. A new lint
// helper (scripts/lib/bundle-wire-scopes.ts, 2026-09-12) passed every local
// lint and typecheck, and the only thing that noticed was the CI export gate
// going red after the push, one round trip later. The export's own import
// gate (GATE 5 in scripts/publish/export-repo.mjs) is the authority; it
// stages 4,000 files to answer, so it runs in CI, not before a push. This is
// the cheap local mirror over the one tree where the miss happens: scripts/.
//
// THE RULE. For every file under scripts/ that an `include` glob of the
// manifest matches (and no `exclude` glob carves out), every RELATIVE import
// must resolve to a file some `include` glob also matches. Bare specifiers are
// a package.json question. Imports written inside a template literal are text
// the script emits, not its own imports (the export gate has the same rule).
// A file under scripts/templates/ is scaffolding for a generated project and
// is skipped. There is no opt-out: an unshipped helper cannot run for anyone
// who clones the public repo.
//
// PROVED RED on scripts/lint-bundle-content.ts importing
// ./lib/bundle-wire-scopes.js before that file was added to the manifest.
//
//   npx tsx scripts/lint-shipped-script-imports.ts   (pnpm run lint:shipped-script-imports)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MANIFEST = join(ROOT, "scripts/publish/manifests/core.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { include?: string[]; exclude?: string[] };
const include = manifest.include ?? [];
const exclude = manifest.exclude ?? [];

/** Glob match with the exporter's semantics: `*` does not cross `/`, `**` does. */
function matches(path: string, pattern: string): boolean {
  const rx = new RegExp(
    "^" +
      pattern
        .split("**")
        .map((chunk) =>
          chunk
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
        )
        .join(".*") +
      "$",
  );
  return rx.test(path);
}
const shipped = (rel: string) => include.some((p) => matches(rel, p)) && !exclude.some((p) => matches(rel, p));

const CANDIDATE_EXT = ["", ".ts", ".tsx", ".mjs", ".js", ".mts", "/index.ts", "/index.mjs", "/index.tsx"];

function insideTemplate(src: string, at: number): boolean {
  let ticks = 0;
  for (let i = 0; i < at; i++) if (src[i] === "`" && src[i - 1] !== "\\") ticks++;
  return ticks % 2 === 1;
}

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
    else if (/\.(ts|tsx|mjs|mts|js)$/.test(name)) yield p;
  }
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const rel = relative(ROOT, file);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["'](\.[^"']+)["']/g)) {
    if (insideTemplate(src, m.index ?? 0)) continue;
    const spec = m[1]!;
    const stems = [spec, spec.replace(/\.js$/, ".ts"), spec.replace(/\.js$/, ".tsx"), spec.replace(/\.mjs$/, ".mts")];
    const targets = stems.flatMap((s) => CANDIDATE_EXT.map((ext) => join(dirname(rel), s + ext)));
    const present = targets.find((t) => existsSync(join(ROOT, t)));
    if (!present) continue; // a missing file is the typechecker's finding, not this one
    if (shipped(present)) continue;
    const line = src.slice(0, m.index ?? 0).split("\n").length;
    out.push({ file: rel, line, what: `imports ${spec} (${present}), which no manifest include ships` });
  }
  return out;
}

const violations: Violation[] = [];
for (const file of walk(join(ROOT, "scripts"))) {
  const rel = relative(ROOT, file);
  if (rel.split("/").includes("templates")) continue;
  if (!shipped(rel)) continue;
  violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:shipped-script-imports - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "A shipped script imports a helper the public export does not ship, so it cannot run for anyone who\n" +
      "clones the public repo. Add the helper to `include` in scripts/publish/manifests/core.json.",
  );
  process.exit(1);
}
console.log(`lint:shipped-script-imports OK`);
