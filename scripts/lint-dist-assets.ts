#!/usr/bin/env tsx
/**
 * lint:dist-assets — server code may only import what the build actually ships.
 *
 * The api is built by TRANSPILING .ts to dist. A .json (or .txt, .yml, …) next
 * to the source is not copied, so an import of it resolves perfectly under tsx
 * and fails in the built image with ERR_MODULE_NOT_FOUND — which surfaces as
 * "[modules] failed to import api for <module>" and then every test for that
 * module failing at once, looking for all the world like a flake.
 *
 * That is exactly how it shipped: a generated capability list imported as JSON,
 * green on typecheck, green under tsx, dead in dist. Generated data belongs in
 * a .ts file, which travels the same road as the code that reads it.
 *
 * Only assets INSIDE src/ are a problem. One kept beside the package (digifab's
 * driver catalog, at modules/digifab/drivers-catalog/) is imported from dist by
 * a path that climbs out of it, so the file is still there at runtime. That is
 * a legitimate pattern and this leaves it alone.
 *
 * Run: npx tsx scripts/lint-dist-assets.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
/** Transpiled to dist and run by plain node — the shape that loses assets. */
const BUILT = ["api/src", "modules"];
/** A relative import of a non-code file. */
const ASSET_IMPORT = /(?:import|from)\s+["'](\.[^"']*\.(json|txt|md|ya?ml|csv))["']/g;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(rel);
  }
  return out;
}

const findings: string[] = [];
for (const file of BUILT.flatMap((d) => walk(d))) {
  const src = readFileSync(join(ROOT, file), "utf8");
  for (const m of src.matchAll(ASSET_IMPORT)) {
    const spec = m[1]!;
    // Where the asset actually lives. Inside a transpiled src/ tree it is lost
    // in dist; anywhere else it is still on disk beside the built output.
    const abs = resolve(dirname(join(ROOT, file)), spec);
    const insideSrc = relative(ROOT, abs).split("/").includes("src");
    if (insideSrc) findings.push(`  ${file}  imports ${spec}`);
  }
}

if (findings.length) {
  console.error(`❌ ${findings.length} import(s) of a file the build will not ship:\n`);
  console.error(findings.join("\n"));
  console.error(
    "\nThe api is transpiled to dist; only .ts becomes .js there, and nothing else is\n" +
      "copied. It will work under tsx and fail in the image. Generate a .ts module, or\n" +
      "read the file at runtime with a path resolved from import.meta.url.",
  );
  process.exit(1);
}
console.log("dist-assets lint: clean (no server code imports an unshipped file)");
