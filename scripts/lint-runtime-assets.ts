// Guard: if api code reads a repo file at runtime, the image must ship that file.
//
// The trap: `bundles/`, `changelog.d/`, `deploy/seeds/` are ordinary directories
// in the repo, so code that reads them works locally, in `tsx watch`, and in
// every test — and then resolves to nothing inside the container, because the
// runtime stage copies a hand-written list of paths and nobody added yours. The
// failure is silent by construction: a missing asset directory is not a crash,
// it is a feature that quietly does nothing.
//
// That is not hypothetical. The no-account sandbox seeds itself from
// deploy/seeds/<name>.json; the loader treats a missing file as "skip the seed
// and hand over an empty-but-working workspace", which is the right behaviour
// for a bad seed and exactly the wrong way to find out the image never had one.
// Every visitor would have landed on an empty table — the single thing the seed
// exists to prevent — with a clean log and a green deploy.
//
// So: resolve the paths statically and check the Dockerfile ships them.
//
// How it resolves: a file at api/src/<p>/x.ts runs from api/dist/<p>/x.js (the
// image builds with esbuild transpile-only, which preserves tsc's layout), so a
// literal in `path.resolve(HERE, "…")` is resolved against api/dist/<p>. Any
// result landing outside api/ is a repo-root asset and must be COPYied.
//
// Run: npx tsx scripts/lint-runtime-assets.ts

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";

const SRC_ROOT = "api/src";
const DOCKERFILE = "docker/api.Dockerfile";
const REPO = process.cwd();

/** `path.resolve(HERE, "…")` / `path.join(__dirname, "…")` — the idiom that can
 *  walk out of the package. Single or double quoted. */
const REL_CALL = /path\.(?:resolve|join)\(\s*(?:HERE|__dirname)\s*,\s*["'`]([^"'`]+)["'`]/g;
/** An absolute container path, the other way runtime assets get named. */
const APP_ABS = /["'`]\/app\/([a-z][a-z0-9._-]*(?:\/[a-z][a-z0-9._-]*)*)["'`]/g;

interface Need {
  /** repo-relative directory or file the image must contain, e.g. deploy/seeds */
  path: string;
  where: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

function collectNeeds(): Need[] {
  const needs: Need[] = [];
  for (const file of walk(SRC_ROOT)) {
    const body = readFileSync(file, "utf8");
    // Where this file lives at runtime: api/src/<p> → api/dist/<p>.
    const runtimeDir = dirname(file).replace(/^api\/src(\/|$)/, "api/dist$1");

    for (const m of body.matchAll(REL_CALL)) {
      const literal = m[1]!;
      // Only literal segments can be checked; a template hole could be anything.
      if (literal.includes("${")) continue;
      const abs = resolve(REPO, runtimeDir, literal);
      const rel = relative(REPO, abs);
      if (rel.startsWith("..")) continue; // outside the repo entirely — not ours
      const top = rel.split(sep)[0]!;
      if (top === "api" || top === "node_modules") continue; // inside the package
      needs.push({ path: rel, where: `${file} → path.resolve(HERE, "${literal}")` });
    }

    for (const m of body.matchAll(APP_ABS)) {
      const rel = m[1]!;
      const top = rel.split("/")[0]!;
      if (top === "api" || top === "node_modules") continue;
      needs.push({ path: rel, where: `${file} → "/app/${rel}"` });
    }
  }
  return needs;
}

interface Copied {
  dest: string;
  /** true for `COPY --from=builder …`: the source is produced during the build,
   *  so it is legitimately absent from the repo (installed-modules.manifest.json
   *  is generated). A plain COPY reads the build context and must exist. */
  built: boolean;
}

/** Every destination the runtime stage copies to, repo-relative under /app. */
function copiedDestinations(): Copied[] {
  const df = readFileSync(DOCKERFILE, "utf8");
  // Only the runtime stage matters — a COPY in the builder never ships.
  const runtime = df.slice(df.lastIndexOf("FROM ") === -1 ? 0 : df.indexOf("AS runtime"));
  const dests: Copied[] = [];
  for (const line of runtime.split("\n")) {
    const trimmed = line.trim();
    const m = /^COPY\s+(?:--\S+\s+)*\S+\s+(\S+)\s*$/.exec(trimmed);
    if (!m) continue;
    dests.push({
      dest: m[1]!.replace(/^\.\//, "").replace(/\/$/, ""),
      built: /--from=/.test(trimmed),
    });
  }
  return dests;
}

function main(): void {
  const needs = collectNeeds();
  const dests = copiedDestinations();
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const need of needs) {
    if (seen.has(need.path + need.where)) continue;
    seen.add(need.path + need.where);

    // Covered if the exact path is copied, or an ancestor directory is.
    const covering = dests.find((d) => d.dest === need.path || need.path.startsWith(d.dest + "/"));
    if (!covering) {
      problems.push(
        `  ${need.path} is read at runtime but ${DOCKERFILE} never copies it\n` +
          `      ${need.where}\n` +
          `      fix: add  COPY ${need.path} ./${need.path}  to the runtime stage`,
      );
      continue;
    }
    // A plain COPY of something absent from the repo fails the build outright.
    // (A `--from=` source is generated during the build, so it is exempt.)
    if (!covering.built && !existsSync(need.path)) {
      problems.push(`  ${need.path} is read at runtime but does not exist in the repo\n      ${need.where}`);
    }
  }

  if (problems.length > 0) {
    console.error(`✗ runtime assets missing from the image:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`✓ runtime assets: ${new Set(needs.map((n) => n.path)).size} repo path(s) read at runtime, all shipped`);
}

main();
