// Guard: a FEATURE must touch docs/. Bugfixes restore intended behaviour and
// don't change what's documented; features change what the software does, so they
// get documented — keeps the docs from going stale.
//
// A PR is a "feature" if ANY of:
//   • a conventional `feat:` / `feat(scope):` commit, OR
//   • a bundle/module MINOR-or-MAJOR version bump (a patch bump = a fix, exempt), OR
//   • a NEW modules/<name>/ directory (a new module).
// If it's a feature and NO docs/ file changed → fail. A new module additionally
// wants docs/modules/<name>.md (soft note).
//
// Diffs against main; no-ops with no base. Run: npx tsx scripts/lint-docs.ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function tryGit(cmd: string): string | null {
  try {
    return git(cmd);
  } catch {
    return null;
  }
}
function findBase(): string | null {
  for (const ref of ["origin/main", "forgejo/main", "main"]) {
    const mb = tryGit(`merge-base HEAD ${ref}`);
    if (mb) return mb;
  }
  return null;
}

const base = findBase();
if (!base) {
  console.log("[lint:docs] no base ref (origin/main) — skipping");
  process.exit(0);
}
if (base === tryGit("rev-parse HEAD")) {
  console.log("[lint:docs] HEAD is the base — nothing to check");
  process.exit(0);
}

const changed = git(`diff --name-only ${base}...HEAD`).split("\n").filter(Boolean);
const subjects = git(`log ${base}..HEAD --format=%s`).split("\n").filter(Boolean);

const reasons: string[] = [];

// 1) feat: commit
if (subjects.some((s) => /^feat(\(.+\))?!?:/i.test(s))) reasons.push("a feat: commit");

// 2) minor/major bump (patch = fix, exempt)
function minorOrMajorBump(oldV?: string, newV?: string): boolean {
  if (!oldV || !newV || oldV === newV) return false;
  const [oM, oN] = oldV.split(".").map(Number);
  const [nM, nN] = newV.split(".").map(Number);
  return nM > oM || (nM === oM && nN > oN);
}
function ver(j: unknown): string | undefined {
  const o = j as { manifest?: { version?: string }; version?: string };
  return o?.manifest?.version ?? o?.version;
}
for (const f of changed.filter((f) => /^bundles\/[^/]+\.json$/.test(f))) {
  const oldRaw = tryGit(`show ${base}:${f}`);
  if (!oldRaw || !existsSync(f)) continue;
  try {
    if (minorOrMajorBump(ver(JSON.parse(oldRaw)), ver(JSON.parse(readFileSync(f, "utf8")))))
      reasons.push(`a minor/major bump in ${f}`);
  } catch {
    /* ignore parse */
  }
}
const newModules: string[] = [];
const seenMod = new Set<string>();
for (const f of changed) {
  const m = f.match(/^modules\/([^/]+)\//);
  if (!m || seenMod.has(m[1])) continue;
  seenMod.add(m[1]);
  const mt = `modules/${m[1]}/src/module.ts`;
  const oldMt = tryGit(`show ${base}:${mt}`);
  if (!oldMt) {
    if (existsSync(mt)) newModules.push(m[1]); // module.ts didn't exist at base
    continue;
  }
  if (existsSync(mt)) {
    const oldVer = oldMt.match(/version:\s*"([^"]+)"/)?.[1];
    const newVer = readFileSync(mt, "utf8").match(/version:\s*"([^"]+)"/)?.[1];
    if (minorOrMajorBump(oldVer, newVer)) reasons.push(`a minor/major bump in modules/${m[1]}`);
  }
}
for (const nm of newModules) reasons.push(`a new module modules/${nm}`);

if (reasons.length === 0) {
  console.log("[lint:docs] ✓ no feature detected — no docs required");
  process.exit(0);
}

const docsTouched = changed.some((f) => f.startsWith("docs/"));
if (docsTouched) {
  console.log(`[lint:docs] ✓ feature (${reasons.join("; ")}) + docs/ updated`);
  // soft note: a new module should have its own module doc
  for (const nm of newModules) {
    if (!existsSync(`docs/modules/${nm}.md`)) {
      console.log(`[lint:docs]   note: new module "${nm}" has no docs/modules/${nm}.md yet (convention).`);
    }
  }
  process.exit(0);
}

console.error(
  `[lint:docs] ✗ this PR is a feature (${reasons.join("; ")}) but changes no docs/.\n` +
    "  Features change what the software does — document them (a bugfix wouldn't trip this).\n" +
    "  Update the relevant docs/ (a new module also needs docs/modules/<name>.md + a README row).",
);
process.exit(1);
