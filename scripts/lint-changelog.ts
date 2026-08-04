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
//   announce: true       # optional — opt a MAJOR fix/improvement into the digest too
//   ---
//   One user-facing line. (type: feature → Discord digest; fix/improvement → page only,
//   UNLESS announce: true, which sends the major ones to the digest as well.)
//
// A PR is a "feature" if: a `feat:` commit, a NEW modules/<name>/ dir, or a module
// MINOR-or-MAJOR bump. It SATISFIES the requirement by adding a changelog.d/*.md
// entry — OR (for a bundle feature) bumping a bundles/*.json version, since the
// bundle's own manifest `changelog` already records it. fix:/chore:/docs exempt.
//
// Diffs against main; no-ops with no base. Run: npx tsx scripts/lint-changelog.ts
import { execSync } from "node:child_process";
// @ts-expect-error plain .mjs module, shared with the docs site's lint
import { lintProse } from "./prose-rules.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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
  // `announce: true` opts a major improvement/fix INTO the Discord digest (features
  // always go). Must be a clean boolean — the digest reads /^true$/i, so `announce: yes`
  // would silently NOT announce. Reject it here rather than let intent evaporate.
  const ann = fm.match(/^announce:\s*(.+)$/m)?.[1]?.trim();
  if (ann !== undefined && !/^(true|false)$/i.test(ann)) malformed.push(`${f}: announce: must be true or false (got "${ann}")`);
}
if (malformed.length) {
  console.error(
    "[lint:changelog] ✗ changelog entries need frontmatter with type: AND date: (else they sit under 'Unreleased' and never reach the digest):\n  " +
      malformed.join("\n  "),
  );
  process.exit(1);
}

// ── no maintainer/infra identifier in a PUBLIC changelog entry ──
// changelog.d is served to users (the /changelog page) AND posted to the public Discord
// digest, but it is EXCLUDED from the git export — so the export's forbidden gate never
// checks it. A "companion app" mention leaked to #new-features 2026-08-04 for exactly this
// reason. Reuse the publish manifest's forbidden list as the single source of truth.
let forbidden: RegExp[] = [];
try {
  const mani = JSON.parse(readFileSync("scripts/publish/manifests/core.json", "utf8")) as { forbidden?: string[] };
  forbidden = (mani.forbidden ?? []).map((p) => new RegExp(p, "g"));
} catch {
  /* no manifest → skip (the digest scrub is still the runtime backstop) */
}
const idLeaks: string[] = [];
for (const f of touchedEntries) {
  const raw = readFileSync(f, "utf8");
  for (const re of forbidden) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (m) {
      idLeaks.push(`${f}: contains "${m[0]}" — an identifier that must not reach the public /changelog + Discord digest`);
      break;
    }
  }
}
if (idLeaks.length) {
  console.error(
    "[lint:changelog] ✗ maintainer/infra identifier in a public changelog entry — reword it (e.g. companion app → companion app):\n  " +
      idLeaks.join("\n  "),
  );
  process.exit(1);
}

// ── prose style: entries + their staged docs are USER-FACING writing ──
// The one-liner feeds /changelog + the Discord digest; the ## docs body gets
// spliced verbatim into the public docs at release. Same voice rules as the
// docs site, from ONE table (scripts/prose-rules.mjs). Diff-scoped: only
// entries this push touches are gated; the archive stays as written.
const proseProblems: string[] = [];
for (const f of touchedEntries) {
  for (const h of lintProse(readFileSync(f, "utf8")) as Array<{ line: number; id: string; why: string; excerpt: string }>) {
    proseProblems.push(`${f}:${h.line} [${h.id}] ${h.why}\n      ${h.excerpt}`);
  }
}
if (proseProblems.length) {
  console.error(
    "[lint:changelog] ✗ prose style (rules: scripts/prose-rules.mjs; a genuine false positive can end its line with <!-- prose-ok -->):\n  " +
      proseProblems.join("\n  "),
  );
  process.exit(1);
}


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

// ── staged docs: a feature's changeset carries its user docs ──
// Write-at-merge, publish-at-release (docs/design-decisions/staged-docs-pipeline.md):
// every type: feature entry must say where its docs land (docs_target:) and
// carry the prose (## docs) NOW, while the feature is fresh. The flush
// (scripts/docs-flush.mjs) publishes it once the feature is live. Explicitly
// contributor-facing changes opt out with `docs_target: none (<reason>)`.
const docsProblems: string[] = [];
const touchedScopes = new Set<string>();
for (const f of touchedEntries) {
  const raw = readFileSync(f, "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  if (!/^type:\s*feature\s*$/m.test(fm)) continue;
  const scope = fm.match(/^scope:\s*(.+)$/m)?.[1]?.trim();
  if (scope) touchedScopes.add(scope);
  else
    // A feature with no scope can't be routed to the public-docs page it should
    // update: the docs-debt report (docs repo, scripts/sync-docs-debt.mjs) keys
    // off `scope:`, so a scopeless feature lands in an unroutable bucket and its
    // public docs go stale silently. 152 historical entries already did. Checked
    // only on features this PR touches (diff-scoped), so no retroactive breakage.
    docsProblems.push(
      `${f}: type: feature needs a "scope:" (the area, e.g. labels / scan / inventory) — the public docs-debt report routes by it`,
    );
  const target = fm.match(/^docs_target:\s*(.+)$/m)?.[1]?.trim();
  if (!target) {
    docsProblems.push(
      `${f}: missing docs_target: — "<path.md>#<Heading>" (where the docs publish at release) or "none (<reason>)" for contributor-facing changes`,
    );
    continue;
  }
  if (/^none\s*\(.+\)$/.test(target)) continue;
  const hash = target.indexOf("#");
  const path = hash > 0 ? target.slice(0, hash) : target;
  const heading = hash > 0 ? target.slice(hash + 1).trim() : "";
  if (!path.endsWith(".md") || !heading || !existsSync(path)) {
    docsProblems.push(
      `${f}: docs_target must be "<existing .md path>#<heading text>" — got "${target}"`,
    );
  }
  const docsBody = raw.split(/^## docs\s*$/m)[1]?.trim();
  if (!docsBody) {
    docsProblems.push(
      `${f}: type: feature needs a non-empty "## docs" section — write the user docs while the feature is fresh; the flush publishes them when it ships`,
    );
  }
}
if (docsProblems.length) {
  console.error("[lint:changelog] ✗ staged-docs check failed:\n  " + docsProblems.join("\n  "));
  process.exit(1);
}

// Freshness rail (NON-fatal): this feature PR shares a scope with staged
// (unpublished) blurbs it didn't touch — if it changes that feature's
// behavior, the staged docs must change too. A nudge, not a gate: same-scope
// features legitimately coexist.
if (touchedScopes.size > 0) {
  const staged: string[] = [];
  for (const name of readdirSync("changelog.d")) {
    const p = `changelog.d/${name}`;
    if (!name.endsWith(".md") || name === "README.md" || touchedEntries.includes(p)) continue;
    const raw = readFileSync(p, "utf8");
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    if (!/^type:\s*feature\s*$/m.test(fm)) continue;
    if (/^docs_published:/m.test(fm)) continue;
    if (!/^## docs\s*$/m.test(raw)) continue;
    const scope = fm.match(/^scope:\s*(.+)$/m)?.[1]?.trim();
    if (scope && touchedScopes.has(scope)) staged.push(`${p} (scope: ${scope})`);
  }
  if (staged.length) {
    console.log(
      "[lint:changelog] note: staged docs blurbs share this PR's scope — if this PR changes that feature's behavior, update their ## docs too:\n  " +
        staged.join("\n  "),
    );
  }
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
    "    changelog.d/<slug>.md  (see changelog.d/README.md). type: feature → digest; fix/improvement → page only (add announce: true to send a major one to the digest too).\n" +
    "  (A bundle feature is covered by its manifest `changelog` bump instead.)",
);
process.exit(1);
