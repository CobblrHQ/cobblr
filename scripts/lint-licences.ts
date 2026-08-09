#!/usr/bin/env tsx
/**
 * lint:licences — every licence Cobblr publishes is one of two, deliberately.
 *
 *   core          Functional Source License 1.1, converting to Apache-2.0 (FSL-1.1-ALv2)
 *   everything else  Apache License 2.0
 *
 * Those are the same terminal licence: core's FSL converts to Apache-2.0, so the
 * satellites are not a second family, they are that end state arriving early.
 *
 * The edge-bridge overlay shipped MIT, left over from when core's own licence was
 * described as "FSL-1.1-MIT". Nothing noticed, because a licence file is not code:
 * it does not fail a build, a test, or a typecheck. The only way it surfaces is
 * somebody reading it, which for a licence is exactly too late.
 *
 * Checks:
 *   1. Root LICENSE.md and the core overlay are FSL-1.1 with an ALv2 future licence
 *      (a "MIT Future License" here is the specific historical mistake).
 *   2. Every OTHER publish overlay's licence is canonical Apache-2.0.
 *   3. No licence file, and no manifest note, claims MIT.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OVERLAY = "scripts/publish/overlay";
const MANIFESTS = "scripts/publish/manifests";

const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : "");
// \b so LIMITATION does not match: it contains the letters but not the word.
const MIT = /\bMIT\b/;
const fails: string[] = [];

function expectFsl(rel: string) {
  const t = read(rel);
  if (!t) return fails.push(`${rel} is missing; core's licence must be present.`);
  if (!/Functional Source License/.test(t)) fails.push(`${rel} is not the Functional Source License.`);
  if (!/ALv2|Apache License, Version 2\.0/.test(t)) {
    fails.push(`${rel} does not name Apache-2.0 as the future licence (FSL-1.1-ALv2).`);
  }
  if (/MIT Future License/.test(t)) {
    fails.push(`${rel} says "MIT Future License". Core converts to Apache-2.0, not MIT.`);
  }
}

function expectApache(rel: string) {
  const t = read(rel);
  if (!t) return fails.push(`${rel} is missing.`);
  const ok =
    /Apache License\s*\n?\s*Version 2\.0, January 2004/.test(t) &&
    /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/.test(t);
  if (!ok) {
    fails.push(
      `${rel} is not the canonical Apache-2.0 text.\n` +
        `      Satellites are Apache-2.0 (core's FSL converts to it, so this is the same\n` +
        `      terminal licence). Copy the full text, do not summarise it.`,
    );
  }
}

expectFsl("LICENSE.md");
expectFsl(`${OVERLAY}/core/LICENSE.md`);

// Every overlay other than core.
let checked = 2;
if (existsSync(join(ROOT, OVERLAY))) {
  for (const repo of readdirSync(join(ROOT, OVERLAY))) {
    if (repo === "core" || !statSync(join(ROOT, OVERLAY, repo)).isDirectory()) continue;
    const licences = readdirSync(join(ROOT, OVERLAY, repo)).filter((f) => /^LICEN[CS]E/.test(f));
    if (!licences.length) {
      fails.push(`${OVERLAY}/${repo}/ has no licence file. A published repo without one is "all rights reserved".`);
      continue;
    }
    for (const f of licences) {
      expectApache(`${OVERLAY}/${repo}/${f}`);
      checked++;
    }
  }
}

// No licence file, anywhere in the overlays, may claim MIT.
if (existsSync(join(ROOT, OVERLAY))) {
  for (const repo of readdirSync(join(ROOT, OVERLAY))) {
    const dir = join(ROOT, OVERLAY, repo);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => /^LICEN[CS]E/.test(x))) {
      const rel = `${OVERLAY}/${repo}/${f}`;
      if (MIT.test(read(rel))) fails.push(`${rel} mentions MIT. Cobblr publishes FSL-1.1-ALv2 (core) or Apache-2.0.`);
    }
  }
}

// A manifest note that says MIT is how a stale licence claim survives a fix.
if (existsSync(join(ROOT, MANIFESTS))) {
  for (const f of readdirSync(join(ROOT, MANIFESTS)).filter((x) => x.endsWith(".json"))) {
    const rel = `${MANIFESTS}/${f}`;
    const notes = Object.entries(JSON.parse(read(rel)) as Record<string, unknown>)
      .filter(([k, v]) => k.startsWith("_note") && typeof v === "string")
      .map(([, v]) => v as string);
    for (const n of notes) {
      if (MIT.test(n)) fails.push(`${rel} has a note claiming MIT: "${n.slice(0, 80)}…"`);
    }
  }
}

if (fails.length) {
  console.error("lint:licences FAILED\n");
  for (const f of fails) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`lint:licences OK (${checked} licence file(s): core FSL-1.1-ALv2, satellites Apache-2.0)`);
