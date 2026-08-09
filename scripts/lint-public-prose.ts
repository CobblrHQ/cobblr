#!/usr/bin/env tsx
/**
 * lint:public-prose — prose a stranger reads is held to the house voice.
 *
 * The voice rules (scripts/prose-rules.mjs) were enforced in exactly two places:
 * changelog entries, and user-facing strings inside web/src + modules .tsx. Nothing
 * checked MARKDOWN. So the files a new reader meets first went unlinted, and on
 * 2026-08-09 a hand-written README for the public module registry shipped with
 * three em dashes in it. It was authored straight into a repo that has no CI, which
 * is the other half of how that happens.
 *
 * Both halves are closed here: the registry's files now live in
 * scripts/publish/registry/ (pushed by scripts/publish/push-registry.mjs, never
 * hand-edited), and this lint covers the public prose set below.
 *
 * ZERO-TOLERANCE files are freshly authored for the public and must stay clean.
 * BASELINED files are long-standing docs, recorded in
 * scripts/public-prose-baseline.json so the lint can be adopted without a rewrite
 * and still fail on anything NEW, the same shape as lint:no-emdash.
 *
 * The baseline is currently EMPTY: the 29 pre-existing hits in those four docs were
 * fixed rather than recorded, so every file here is effectively zero-tolerance today.
 * Keep it that way. The mechanism stays for onboarding a doc that is not clean yet;
 * refresh with --update after a deliberate cleanup, never to excuse a new violation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs, the single source of truth for the voice
import { lintProse } from "./prose-rules.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE_PATH = join(ROOT, "scripts/public-prose-baseline.json");

/** Authored for the public and expected to be clean, with no baseline. */
const ZERO_TOLERANCE = ["scripts/publish/registry/README.md"];

/** Public-facing, long-standing: linted with a baseline for existing hits. */
const BASELINED = ["README.md", "SELF_HOSTING.md", "SECURITY.md", "changelog.d/README.md"];

type Hit = { file: string; line: number; id: string; why: string; excerpt: string };

function hitsFor(rel: string): Hit[] {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return [];
  return (lintProse(readFileSync(p, "utf8")) as Omit<Hit, "file">[]).map((h) => ({ ...h, file: rel }));
}

const zero = ZERO_TOLERANCE.flatMap(hitsFor);
const baselinedHits = BASELINED.flatMap(hitsFor);

const key = (h: { file: string; excerpt: string }) => `${h.file}::${h.excerpt}`;

if (process.argv.includes("--update")) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(baselinedHits.map((h) => ({ file: h.file, excerpt: h.excerpt })), null, 2) + "\n",
  );
  console.log(`lint:public-prose: baseline refreshed (${baselinedHits.length} recorded)`);
  process.exit(0);
}

const baseline: { file: string; excerpt: string }[] = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : [];
const known = new Set(baseline.map(key));
const fresh = baselinedHits.filter((h) => !known.has(key(h)));

if (zero.length || fresh.length) {
  console.error("lint:public-prose FAILED\n");
  for (const h of zero) {
    console.error(`  ✗ ${h.file}:${h.line} [${h.id}] ${h.why}\n      ${h.excerpt}`);
  }
  for (const h of fresh) {
    console.error(`  ✗ ${h.file}:${h.line} [${h.id}] ${h.why}  (NEW, not in the baseline)\n      ${h.excerpt}`);
  }
  console.error(
    "\n  Rules: scripts/prose-rules.mjs. A genuine false positive in a baselined file can be\n" +
      "  recorded with `pnpm run lint:public-prose --update`, but never to excuse a new one.",
  );
  process.exit(1);
}

const fixed = baseline.filter((b) => !baselinedHits.some((h) => key(h) === key(b)));
console.log(
  `lint:public-prose OK (${ZERO_TOLERANCE.length} zero-tolerance + ${BASELINED.length} baselined file(s), ` +
    `${baseline.length} known)` + (fixed.length ? ` — ${fixed.length} baselined hit(s) now fixed; run --update to shrink it` : ""),
);
