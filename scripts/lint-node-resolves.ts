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
// Run: npx tsx scripts/lint-node-resolves.ts

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RESOLUTION_ERRORS = [
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_INVALID_MODULE_SPECIFIER",
];

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
  const ex = pkg.exports;
  const targets =
    ex && typeof ex === "object"
      ? Object.entries(ex as Record<string, string>)
      : pkg.main
        ? ([[".", pkg.main]] as Array<[string, string]>)
        : [];
  return targets
    .filter(([, target]) => typeof target === "string" && /(^|\/)src\//.test(target))
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
      const code = RESOLUTION_ERRORS.find((c) => stderr.includes(c));
      const line = stderr.split("\n").find((l) => l.includes("Error")) ?? stderr.split("\n")[0] ?? "";
      if (code) failures.push({ spec, code, msg: line.trim().slice(0, 160) });
      else console.log(`  (${spec} resolved but threw at import time, not a resolution problem)`);
    }
  }
}

if (failures.length > 0) {
  console.error(`node-resolves lint: an entry point the API imports does not load under plain Node.\n`);
  for (const f of failures) {
    console.error(`    ❌ ${f.spec}`);
    console.error(`       ${f.code}: ${f.msg}`);
  }
  console.error(
    `\n  tsc and tsx both rewrite a "./foo.js" specifier to foo.ts; node does not.` +
      `\n  In a source-first package, import the real extension or reach the file` +
      `\n  through an exports subpath instead of a relative re-export.`,
  );
  process.exit(1);
}

console.log(`node-resolves lint: ${checked} api entry point(s) load under plain node ✓`);
