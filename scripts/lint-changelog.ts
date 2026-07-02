// Guard: a FEATURE must record a user-facing changelog entry, so "what's new" is
// systematic (it feeds the /changelog page + the 8pm Discord digest) rather than
// "when an agent remembers".
//
// Multi-agent-safe by design: one changeset FILE per change
// (changelog.d/<slug>.md), never a shared CHANGELOG.md that every parallel PR
// would conflict on. Format:
//
//   changelog.d/<slug>.md
//   ---
//   type: feature        # feature | fix | improvement
//   scope: bundles       # optional
//   ---
//   One user-facing line. (type: feature → goes in the Discord digest; fix → page only.)
//
// A PR is a "feature" if: a `feat:` commit, a NEW modules/<name>/ dir, or a module
// MINOR-or-MAJOR bump. It SATISFIES the requirement by adding a changelog.d/*.md
// entry — OR (for a bundle feature) bumping a bundles/*.json version, since the
// bundle's own manifest `changelog` already records it. fix:/chore:/docs exempt.
//
// Diffs against main; no-ops with no base. Run: npx tsx scripts/lint-changelog.ts
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
  console.log("[lint:changelog] no base ref (origin/main) — skipping");
  process.exit(0);
}
if (base === tryGit("rev-parse HEAD")) {
  console.log("[lint:changelog] HEAD is the base — nothing to check");
  process.exit(0);
}

const changed = git(`diff --name-only ${base}...HEAD`).split("\n").filter(Boolean);
const subjects = git(`log ${base}..HEAD --format=%s`).split("\n").filter(Boolean);

function ver(j: unknown): string | undefined {
  const o = j as { manifest?: { version?: string }; version?: string };
  return o?.manifest?.version ?? o?.version;
}
function minorOrMajor(oldV?: string, newV?: string): boolean {
  if (!oldV || !newV || oldV === newV) return false;
  const [oM, oN] = oldV.split(".").map(Number);
  const [nM, nN] = newV.split(".").map(Number);
  return nM > oM || (nM === oM && nN > oN);
}

// ── is this a feature? ──
const reasons: string[] = [];
if (subjects.some((s) => /^feat(\(.+\))?!?:/i.test(s))) reasons.push("a feat: commit");
const seenMod = new Set<string>();
for (const f of changed) {
  const m = f.match(/^modules\/([^/]+)\//);
  if (!m || seenMod.has(m[1])) continue;
  seenMod.add(m[1]);
  const mt = `modules/${m[1]}/src/module.ts`;
  const oldMt = tryGit(`show ${base}:${mt}`);
  if (!oldMt) {
    if (existsSync(mt)) reasons.push(`a new module modules/${m[1]}`);
    continue;
  }
  if (existsSync(mt) && minorOrMajor(oldMt.match(/version:\s*"([^"]+)"/)?.[1], readFileSync(mt, "utf8").match(/version:\s*"([^"]+)"/)?.[1]))
    reasons.push(`a minor/major bump in modules/${m[1]}`);
}

if (reasons.length === 0) {
  console.log("[lint:changelog] ✓ no feature detected — no changelog entry required");
  process.exit(0);
}

// ── every touched entry must carry full frontmatter (type + date) ──
// 200+ entries once piled up under "Unreleased" (missing date:) and three
// features never reached the digest (missing type:) — enforce at the gate.
const touchedEntries = changed.filter(
  (f) => /^changelog\.d\/.+\.md$/.test(f) && !f.endsWith("/README.md") && existsSync(f),
);
const malformed: string[] = [];
for (const f of touchedEntries) {
  const raw = readFileSync(f, "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  if (!/^type:\s*(feature|improvement|fix)\s*$/m.test(fm)) malformed.push(`${f}: missing/invalid type:`);
  if (!/^date:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(fm)) malformed.push(`${f}: missing/invalid date: YYYY-MM-DD`);
}
if (malformed.length) {
  console.error(
    "[lint:changelog] ✗ changelog entries need frontmatter with type: AND date: (else they sit under 'Unreleased' and never reach the digest):\n  " +
      malformed.join("\n  "),
  );
  process.exit(1);
}

// ── satisfied? a changeset file, OR a bundle version bump (manifest changelog covers it) ──
const hasChangeset = touchedEntries.length > 0;
let bundleBumped = false;
for (const f of changed.filter((f) => /^bundles\/[^/]+\.json$/.test(f))) {
  const oldRaw = tryGit(`show ${base}:${f}`);
  if (!oldRaw || !existsSync(f)) continue;
  try {
    if (ver(JSON.parse(oldRaw)) !== ver(JSON.parse(readFileSync(f, "utf8")))) bundleBumped = true;
  } catch {
    /* ignore */
  }
}

if (hasChangeset || bundleBumped) {
  console.log(`[lint:changelog] ✓ feature (${reasons.join("; ")}) + ${hasChangeset ? "changelog.d/ entry" : "a bundle changelog bump"}`);
  process.exit(0);
}

console.error(
  `[lint:changelog] ✗ this PR is a feature (${reasons.join("; ")}) but adds no changelog entry.\n` +
    "  Add a user-facing one-liner so it reaches /changelog + the daily digest:\n" +
    "    changelog.d/<slug>.md  (see changelog.d/README.md). type: feature → digest; fix → page only.\n" +
    "  (A bundle feature is covered by its manifest `changelog` bump instead.)",
);
process.exit(1);
