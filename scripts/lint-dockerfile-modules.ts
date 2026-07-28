// Guard: every module under modules/ must be copied into docker/api.Dockerfile.
//
// The trap this catches: a new module builds fine, typechecks, passes CI, and
// runs locally (the loader scans the modules/ dir on disk) — but is INVISIBLE in
// the built image, so it silently never loads in prod. (maker-scan hit exactly
// this: 35 modules loaded instead of 36, no error anywhere.)
//
// The image now copies the WHOLE modules dir in one layer (`COPY modules
// ./modules`) and builds every module with one esbuild pass — so no module can be
// forgotten, and this lint is satisfied by that single blanket copy. (It used to
// require an explicit `COPY modules/<name> …` per module, for per-module tsc
// cache layers; those are gone.) If the blanket copy is ever removed in favour of
// explicit per-module copies again, this falls back to checking each one.
// Run: npx tsx scripts/lint-dockerfile-modules.ts

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "modules";
const DOCKERFILE = "docker/api.Dockerfile";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const df = readFileSync(DOCKERFILE, "utf8");

// REVERSE check, always on: every explicit `COPY modules/<name>/...` line must
// reference a module that still exists. The install layer hand-enumerates
// per-module package.json copies for caching, and a DELETED module's line
// fails the image build with "not found" — post-merge only, because images
// build on push to main, not on PR CI (the labels merge hit exactly this).
const staleCopies: string[] = [];
for (const m of df.matchAll(/^COPY\s+modules\/([A-Za-z0-9_-]+)\//gm)) {
  const name = m[1]!;
  if (!existsSync(join(MODULES_DIR, name))) staleCopies.push(name);
}
if (staleCopies.length > 0) {
  console.error(
    `dockerfile-modules lint: ${DOCKERFILE} copies ${staleCopies.length} module(s) that no longer exist:\n`,
  );
  for (const m of [...new Set(staleCopies)]) console.error(`  ❌ modules/${m}`);
  console.error(
    `\nA deleted module's COPY line fails the image build AFTER merge (images\n` +
      `build on push to main). Remove the stale line(s) from ${DOCKERFILE}.`,
  );
  process.exit(1);
}

// Blanket copy of the whole dir → every module (present + future) is in the image.
const blanketCopy = /^COPY\s+modules\s+\.\/modules\b/m;
const modulesCoveredByBlanket = blanketCopy.test(df);
if (modulesCoveredByBlanket) {
  console.log(
    `dockerfile-modules lint: whole modules/ dir copied via blanket \`COPY modules ./modules\` — all modules covered ✓`,
  );
}

const modules = modulesCoveredByBlanket ? [] : readdirSync(MODULES_DIR).filter((d) => {
  if (d.startsWith(".")) return false;
  const p = join(MODULES_DIR, d);
  return statSync(p).isDirectory() && existsSync(join(p, "package.json"));
});

const missing: string[] = [];
for (const m of modules) {
  // The source copy: `COPY modules/<name> ./modules/<name>` (the line that
  // puts the module's code in the image; the package.json-only copy isn't
  // enough — without source the module never loads).
  const srcCopy = new RegExp(`^COPY\\s+modules/${escapeRegex(m)}\\s+\\./modules/${escapeRegex(m)}\\b`, "m");
  if (!srcCopy.test(df)) missing.push(m);
}

if (missing.length > 0) {
  console.error(
    `dockerfile-modules lint: ${missing.length} module(s) under modules/ are NOT copied into ${DOCKERFILE}:\n`,
  );
  for (const m of missing) {
    console.error(`  ❌ ${m}`);
  }
  console.error(
    `\nThese build + pass CI + run locally, but are INVISIBLE in the built image —\n` +
      `they silently never load in prod. Add BOTH lines to ${DOCKERFILE}\n` +
      `(mirror an existing connector like bricklink-connector):\n` +
      `  COPY modules/<name>/package.json ./modules/<name>/   (in the package.json block)\n` +
      `  COPY modules/<name> ./modules/<name>                 (in the source block)\n` +
      `  RUN npm run --if-present build -w @cobblr/<name>\n`,
  );
  process.exit(1);
}

if (!modulesCoveredByBlanket) {
  console.log(`dockerfile-modules lint: all ${modules.length} module(s) are copied into ${DOCKERFILE} ✓`);
}

// ── workspace PACKAGES (packages/*) ────────────────────────────────────────
// The same trap, one directory over. Each image hand-enumerates the packages it
// needs (twice: once for the package.json install layer, once for source), and
// adding a package to the repo does not add it there. CI's typecheck job runs a
// full pnpm install over the real tree, so it passes; only the IMAGE build uses
// the curated list, and that only runs on push to main. Net effect: a new
// package turns main red after merge, with an error that looks nothing like its
// cause. (@cobblr/thermal-print hit exactly this.)
interface ImageSpec {
  dockerfile: string;
  /** Workspace dirs whose deps the image must satisfy. */
  entries: string[];
}
/** The api image COPIES modules/ wholesale and MOUNTS every module at boot, so
 *  a package any module depends on has to be in the image too — walking `api`
 *  alone missed all of them, because api does not depend on the modules it
 *  loads.
 *
 *  That shipped and took the Labels page down in production: labels imported
 *  @cobblr/thermal-print for the model table, nothing copied the package, and
 *  the module failed to mount with ERR_MODULE_NOT_FOUND behind a dangling
 *  symlink. Every route under /modules/labels 404'd, so the page rendered with
 *  no queue and no browse panel and read as "Labels is broken" rather than as a
 *  missing file. */
const MODULE_DIRS = existsSync("modules")
  ? readdirSync("modules")
      .map((d) => join("modules", d))
      .filter((d) => existsSync(join(d, "package.json")))
  : [];
const IMAGES: ImageSpec[] = [
  { dockerfile: "docker/web.Dockerfile", entries: ["web"] },
  { dockerfile: "docker/api.Dockerfile", entries: ["api", ...MODULE_DIRS] },
];

/** name -> dir for every workspace package that lives under packages/. */
function packageDirs(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync("packages")) return out;
  for (const d of readdirSync("packages")) {
    const pj = join("packages", d, "package.json");
    if (!existsSync(pj)) continue;
    const name = JSON.parse(readFileSync(pj, "utf8")).name;
    if (typeof name === "string") out.set(name, d);
  }
  return out;
}

/** Transitive @cobblr/* deps of a workspace dir, restricted to packages/. */
function neededPackages(entryDirs: string[], pkgDirs: Map<string, string>): Set<string> {
  const seen = new Set<string>();
  const need = new Set<string>();
  const visit = (dir: string) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj) || seen.has(dir)) return;
    seen.add(dir);
    const json = JSON.parse(readFileSync(pj, "utf8"));
    const deps = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith("@cobblr/")) continue;
      const pdir = pkgDirs.get(dep);
      if (pdir) {
        need.add(pdir);
        visit(join("packages", pdir));
      } else {
        // a module dependency — follow it so ITS package deps are counted too
        const mdir = join("modules", dep.replace("@cobblr/", ""));
        if (existsSync(mdir)) visit(mdir);
      }
    }
  };
  for (const d of entryDirs) visit(d);
  return need;
}

const pkgDirs = packageDirs();
let pkgFailures = 0;
for (const img of IMAGES) {
  if (!existsSync(img.dockerfile)) continue;
  const text = readFileSync(img.dockerfile, "utf8");
  // a blanket `COPY packages ./packages` covers everything, present + future
  if (/^COPY\s+packages\s+\.\/packages\b/m.test(text)) {
    console.log(`dockerfile-packages lint: ${img.dockerfile} blanket-copies packages/ ✓`);
    continue;
  }
  const need = neededPackages(img.entries, pkgDirs);
  const missing: string[] = [];
  for (const p of need) {
    const srcCopy = new RegExp(`^COPY\\s+packages/${escapeRegex(p)}\\s+\\./packages/${escapeRegex(p)}\\b`, "m");
    if (!srcCopy.test(text)) missing.push(p);
  }
  if (missing.length > 0) {
    pkgFailures += missing.length;
    console.error(`\ndockerfile-packages lint: ${img.dockerfile} is missing ${missing.length} workspace package(s) it needs:\n`);
    for (const p of missing) console.error(`  ❌ packages/${p}`);
    console.error(
      `\nThe image build will fail to resolve them, but ONLY after merge (images\n` +
        `build on push to main; PR CI installs the whole tree so it passes). Add BOTH:\n` +
        `  COPY packages/<name>/package.json ./packages/<name>/   (package.json block)\n` +
        `  COPY packages/<name> ./packages/<name>                 (source block)\n`,
    );
  } else {
    console.log(`dockerfile-packages lint: ${img.dockerfile} copies all ${need.size} package(s) it needs ✓`);
  }
}
if (pkgFailures > 0) process.exit(1);
