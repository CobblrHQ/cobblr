// Guard: every module under modules/ must be copied into docker/api.Dockerfile.
//
// The api image lists modules EXPLICITLY (one `COPY modules/<name> ...` per
// module) rather than `COPY modules/`, for build-layer caching. The trap: a
// new module builds fine, typechecks, passes CI, and runs locally (the loader
// scans the modules/ dir on disk) — but is INVISIBLE in the built image, so it
// silently never loads in prod. (maker-scan hit exactly this: 35 modules
// loaded instead of 36, no error anywhere.)
//
// This lint compares the modules/ directory against the Dockerfile's COPY
// lines and fails if any module is missing the SOURCE copy (the one that
// actually puts the module in the image). Run: npx tsx scripts/lint-dockerfile-modules.ts

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "modules";
const DOCKERFILE = "docker/api.Dockerfile";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const df = readFileSync(DOCKERFILE, "utf8");

const modules = readdirSync(MODULES_DIR).filter((d) => {
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

console.log(`dockerfile-modules lint: all ${modules.length} module(s) are copied into ${DOCKERFILE} ✓`);
