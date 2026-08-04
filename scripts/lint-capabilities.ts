// One runner for every capability in scripts/capabilities.ts.
//
// Replaces four near-identical bespoke lints. Adding the next capability is a
// row in the registry rather than a new 80-125 line script, and every failure
// reads the same way: what the capability is, why it has one owner, and what to
// use instead.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CAPABILITIES, type Capability } from "./capabilities.js";
import { openingTags, stringLiterals, stripComments } from "./lib/source-scan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Failure {
  file: string;
  line: number;
  cap: Capability;
  detail: string;
  fix: string;
}

const failures: Failure[] = [];
/** A scope that stops existing is a check that silently stopped running. */
const missing: string[] = [];

function read(rel: string): string | null {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    missing.push(rel);
    return null;
  }
  return stripComments(readFileSync(abs, "utf8"));
}

/** Is the phrase acting as a control LABEL - a short standalone string - rather
 *  than a clause inside a sentence? */
function usedAsLabel(line: string, phrase: RegExp): boolean {
  return stringLiterals(line).some((lit) => {
    const inner = lit.trim();
    return phrase.test(inner.toLowerCase()) && inner.replace(/[….?!]/g, "").length <= 24;
  });
}

for (const cap of CAPABILITIES) {
  if (cap.kind === "owns") {
    if (!existsSync(join(ROOT, cap.owner))) missing.push(cap.owner);
    for (const rel of cap.scope) {
      const code = read(rel);
      if (code === null || rel === cap.owner) continue;
      code.split("\n").forEach((line, i) => {
        if (!cap.detect.test(line)) return;
        failures.push({ file: rel, line: i + 1, cap, detail: line.trim().slice(0, 110), fix: cap.use });
      });
    }
  } else if (cap.kind === "requires-prop") {
    for (const rel of cap.scope) {
      const code = read(rel);
      if (code === null) continue;
      const tags = openingTags(code, cap.component);
      if (tags.length === 0) {
        missing.push(`${rel} (no <${cap.component}> render sites)`);
        continue;
      }
      for (const tag of tags) {
        for (const prop of cap.required) {
          if (new RegExp(`\\b${prop}\\s*=`).test(tag.text)) continue;
          failures.push({
            file: rel,
            line: tag.line,
            cap,
            detail: `<${cap.component}> without ${prop}`,
            fix: `pass ${prop} to every <${cap.component}>`,
          });
        }
      }
    }
  } else {
    for (const rel of cap.scope) {
      const code = read(rel);
      if (code === null) continue;
      code.split("\n").forEach((line, i) => {
        for (const t of cap.terms) {
          if (!t.phrase.test(line.toLowerCase())) continue;
          if (t.as === "label" && !usedAsLabel(line, t.phrase)) continue;
          failures.push({
            file: rel,
            line: i + 1,
            cap,
            detail: `${t.as === "label" ? "control label" : "wording"} ${t.phrase}: ${line.trim().slice(0, 90)}`,
            fix: `use ${t.use}`,
          });
        }
      });
    }
  }
}

if (missing.length) {
  console.error(
    `lint:capabilities — these registry paths no longer exist:\n  ${missing.join("\n  ")}\n` +
      `A scope that stops existing is a check that silently stopped running. Update scripts/capabilities.ts.`,
  );
  process.exit(1);
}

if (failures.length) {
  const byCap = new Map<string, Failure[]>();
  for (const f of failures) byCap.set(f.cap.id, [...(byCap.get(f.cap.id) ?? []), f]);
  for (const [id, fs] of byCap) {
    const cap = fs[0]!.cap;
    console.error(`\n✗ ${id} — ${cap.what}`);
    console.error(`  why one owner: ${cap.why}`);
    for (const f of fs) {
      console.error(`  ${f.file}:${f.line}  ${f.detail}`);
      console.error(`      → ${f.fix}`);
    }
  }
  console.error(
    `\nlint:capabilities — ${failures.length} violation(s) across ${byCap.size} capability/capabilities.\n`,
  );
  process.exit(1);
}

const byKind = CAPABILITIES.reduce<Record<string, number>>((a, c) => ({ ...a, [c.kind]: (a[c.kind] ?? 0) + 1 }), {});
console.log(
  `lint:capabilities ✓ ${CAPABILITIES.length} capabilities have one owner ` +
    `(${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")}).`,
);
