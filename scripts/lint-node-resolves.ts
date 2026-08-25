// Guard: every @cobblr/* entry point the API imports must LOAD under plain Node.
//
// The api runs under node. Typecheck runs under tsc and the unit tests run under
// tsx, and BOTH of those resolve a `./foo.js` specifier to `foo.ts`. Plain Node
// does not: it looks for a literal foo.js and throws ERR_MODULE_NOT_FOUND.
//
// So a source-first package can be green on typecheck, green on unit tests, and
// still take the API down at boot. That shipped: adding a second file to
// platform-contract (previously a single file, so no relative import had ever
// existed in it) with a `./qr-token.js` re-export passed everything locally and
// failed in CI at api start.
//
// Loading, not just resolving: `import.meta.resolve` would confirm the entry
// exists but never open it, and the bug was a bad specifier INSIDE the entry.
// Only resolution-class errors fail here; a package that legitimately needs env
// at import time is reported and tolerated.
//
// LOAD errors are the second failure class. Node strips TypeScript types by
// default (strip-ONLY mode, no transform), and a source-first @cobblr/* package
// loaded at boot is parsed that way. Strip-only refuses any syntax that needs
// codegen — parameter properties (`constructor(public x)`), `enum`, `namespace`,
// `import x = require()`, decorators — with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
// tsc and tsx both accept that syntax, so a package can be green on typecheck AND
// on the unit tests (tsx/esbuild transform it) and still crash the api at import.
// That shipped once (platform-net used a parameter property); this lint saw the
// error but filed it under "threw at import time, tolerate" because the code was
// not listed. It is a load failure, not a runtime throw — it fails here now.
// Run: npx tsx scripts/lint-node-resolves.ts

import { readFileSync, globSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RESOLUTION_ERRORS = [
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_INVALID_MODULE_SPECIFIER",
];
// A buildless package that boots the api MUST be strip-safe. This is the same
// crash as a resolution error from the api's point of view: it does not load.
const STRIP_ERRORS = ["ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"];
const BOOT_LOAD_ERRORS = [...RESOLUTION_ERRORS, ...STRIP_ERRORS];

const apiPkg = JSON.parse(readFileSync("api/package.json", "utf8")) as {
  dependencies?: Record<string, string>;
};
const deps = Object.keys(apiPkg.dependencies ?? {}).filter((d) => d.startsWith("@cobblr/"));

/** Root plus every subpath a package publishes, as import specifiers.
 *
 *  SOURCE-FIRST packages only (entry points at src/). A package whose entry is
 *  dist/ is either built, in which case node loads plain compiled js and there is
 *  no divergence to catch, or unbuilt, in which case failing here would just be
 *  reporting "you have not run build" as a lint error. The tsx/tsc-versus-node
 *  gap this guards is specific to shipping TypeScript as the entry point. */
function entryPoints(name: string): string[] {
  const dir = `packages/${name.replace("@cobblr/", "")}`;
  let pkg: { exports?: unknown; main?: string };
  try {
    pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { exports?: unknown; main?: string };
  } catch {
    return []; // not a workspace package dir (a module) — out of scope
  }
  // An exports entry is either a bare path or a CONDITIONS OBJECT
  // ({ types, import, require }). Reading only the bare-path form silently
  // skipped every package using conditions — which is most of them, and included
  // the one whose root entry could not load under node at all. A guard that
  // quietly checks nothing is worse than no guard, because it reports success.
  const firstPath = (target: unknown): string | null => {
    if (typeof target === "string") return target;
    if (target && typeof target === "object") {
      for (const v of Object.values(target as Record<string, unknown>)) {
        const found = firstPath(v);
        if (found) return found;
      }
    }
    return null;
  };
  const ex = pkg.exports;
  const targets: Array<[string, unknown]> =
    ex && typeof ex === "object"
      ? Object.entries(ex as Record<string, unknown>)
      : pkg.main
        ? [[".", pkg.main]]
        : [];
  return targets
    .filter(([, target]) => {
      const path = firstPath(target);
      return !!path && /(^|\/)src\//.test(path);
    })
    .map(([key]) => (key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`));
}

const failures: Array<{ spec: string; code: string; msg: string }> = [];
let checked = 0;

for (const dep of deps) {
  for (const spec of entryPoints(dep)) {
    checked++;
    try {
      // cwd = api so workspace links resolve exactly as they do at boot.
      execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(spec)})`], {
        cwd: "api",
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30_000,
      });
    } catch (e) {
      const stderr = String((e as { stderr?: Buffer }).stderr ?? "");
      const code = BOOT_LOAD_ERRORS.find((c) => stderr.includes(c));
      const line = stderr.split("\n").find((l) => l.includes("Error")) ?? stderr.split("\n")[0] ?? "";
      if (code) failures.push({ spec, code, msg: line.trim().slice(0, 160) });
      else console.log(`  (${spec} resolved but threw at import time, not a resolution problem)`);
    }
  }
}

// The same check for every workspace package a module's SERVER-SIDE code
// imports.
//
// The loop above only covered packages the API lists as its own dependencies. A
// module is mounted in the same process at boot and can pull in a workspace
// package the API has never heard of, where a SOURCE-FIRST entry hits the
// identical tsc/tsx-versus-node gap.
//
// That shipped: labels added @cobblr/thermal-print for the known-model table,
// whose root re-exports `./protocol.js`. Typecheck passed, all 138 unit test
// files passed, and the module failed to mount at boot with
// ERR_MODULE_NOT_FOUND. Importing the package's pure-data subpath fixed it; the
// point of checking here is that nothing short of a boot said so.
//
// Scoped to what the SERVER loads, by reading the imports rather than the
// dependency list. A module's package.json mixes both halves, and its ui half
// legitimately depends on browser-only packages that no server entry ever
// touches — flagging those would be noise, and a noisy lint gets muted.
const SERVER_SIDE = /^modules\/[^/]+\/src\/(?!ui\/)/;
const moduleImports = new Map<string, string>(); // specifier -> first module using it
for (const f of globSync("modules/*/src/**/*.ts")) {
  if (!SERVER_SIDE.test(f)) continue;
  const owner = f.split("/")[1] ?? f;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    // `import type` is erased before node ever sees it, so it cannot fail to
    // load. Counting it flagged a browser-only package that no server entry
    // actually imports.
    if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
    const m = /from\s+["'](@cobblr\/[^"']+)["']/.exec(line);
    if (m?.[1] && !moduleImports.has(m[1])) moduleImports.set(m[1], owner);
  }
}
for (const [spec, owner] of moduleImports) {
  if (deps.includes(spec)) continue; // already covered above
  // Only source-first entries can diverge; entryPoints() decides that.
  const pkgName = spec.split("/").slice(0, 2).join("/");
  if (!entryPoints(pkgName).includes(spec)) continue;
  checked++;
  try {
    // cwd = the MODULE, not api. A module declares its own dependencies and its
    // built code sits under modules/<name>/, so that is where node resolves the
    // specifier at boot. Running this from api/ passed locally on pnpm hoisting
    // and failed in CI's stricter install, which is the wrong way round for a
    // guard: it reported success on the machine where someone would act on it.
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(spec)})`], {
      cwd: `modules/${owner}`,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer }).stderr ?? "");
    const code = BOOT_LOAD_ERRORS.find((c) => stderr.includes(c));
    const line = stderr.split("\n").find((l) => l.includes("Error")) ?? stderr.split("\n")[0] ?? "";
    if (code) failures.push({ spec: `${spec}  (imported by modules/${owner})`, code, msg: line.trim().slice(0, 160) });
  }
}

// ── the same class, one step over: repo SCRIPTS ────────────────────────────
//
// A script in scripts/ that imports a bare `@cobblr/*` specifier resolves fine
// on a dev machine, where pnpm has hoisted the workspace packages into the root
// node_modules, and fails in CI's clean install, where the repo root does not
// depend on them. Green locally, MODULE_NOT_FOUND in CI, which is exactly the
// shape this file already exists for.
//
// It cost a red build on 2026-08-24. The fix is a relative path into the
// package's source, which lint-catalog-schema-complete has always used.
const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const rootDeps = new Set([
  ...Object.keys(rootPkg.dependencies ?? {}),
  ...Object.keys(rootPkg.devDependencies ?? {}),
]);
const scriptImports: string[] = [];
for (const file of globSync("scripts/**/*.ts")) {
  const src = readFileSync(file, "utf8");
  // A real import STATEMENT, anchored to the start of a line. Several lints
  // print `import { x } from "@cobblr/..."` inside their own error text to tell
  // you what to write instead; matching those made the first version of this
  // check report two files that import nothing at all, which sent me chasing a
  // difference between them and mine that did not exist.
  for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+["'](@cobblr\/[^"']+)["']/gm)) {
    const spec = m[1]!;
    const pkg = spec.split("/").slice(0, 2).join("/");
    if (rootDeps.has(pkg)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    scriptImports.push(
      `${file}:${line}  imports "${spec}", which the repo root does not depend on.\n` +
        `       It resolves here only because pnpm hoisted it. Use a relative path:\n` +
        `       ../packages/<pkg>/src/<file>.js`,
    );
  }
}
if (scriptImports.length > 0) {
  console.error(
    "node-resolves lint: a repo script imports a workspace package the root does not depend on.\n",
  );
  for (const s of scriptImports) console.error(`    ❌ ${s}`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`node-resolves lint: an entry point loaded at boot does not load under plain Node.\n`);
  for (const f of failures) {
    console.error(`    ❌ ${f.spec}`);
    console.error(`       ${f.code}: ${f.msg}`);
  }
  console.error(
    `\n  ERR_MODULE_NOT_FOUND etc: tsc and tsx both rewrite a "./foo.js" specifier` +
      `\n    to foo.ts; node does not. Import the real extension, or reach the file` +
      `\n    through an exports subpath instead of a relative re-export.` +
      `\n  ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: node strips types (no transform), so a` +
      `\n    buildless package must avoid parameter properties, enum, namespace, and` +
      `\n    decorators. Declare the field and assign it in the constructor body.`,
  );
  process.exit(1);
}

console.log(`node-resolves lint: ${checked} boot entry point(s) load under plain node ✓`);
