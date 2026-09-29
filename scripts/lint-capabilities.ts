// One runner for every capability in scripts/capabilities.ts.
//
// Replaces four near-identical bespoke lints. Adding the next capability is a
// row in the registry rather than a new 80-125 line script, and every failure
// reads the same way: what the capability is, why it has one owner, and what to
// use instead.

import { existsSync, globSync, readFileSync } from "node:fs";
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

/** A scope entry is a file, or a glob for a family of files that grows (every
 *  lint, say), so a rule covers the next member without anyone editing the
 *  row. A glob that matches nothing is a scope that stopped existing. */
function expand(scope: string[]): string[] {
  const out: string[] = [];
  for (const rel of scope) {
    if (!rel.includes("*")) {
      out.push(rel);
      continue;
    }
    const hits = globOnce(rel);
    if (hits.length === 0) missing.push(`${rel} (matches no file)`);
    out.push(...hits);
  }
  return out;
}

// ONE GLOB PER PATTERN, ONE READ PER FILE. Every row expanded its own scope
// and read and stripped every file it named, with no cache, so a broad row
// (`web/src/**`) re-read the whole web tree once per row that scoped it, and
// the lint's time grew as rows x tree: 1.1 s when recorded, 6-14 s in CI a
// fortnight later, and 48 s on a busy runner, which failed main on its time
// budget (2026-09-28). Neither the tree nor a file changes during one run.
const globCache = new Map<string, string[]>();
function globOnce(rel: string): string[] {
  let hits = globCache.get(rel);
  if (!hits) {
    hits = globSync(rel, { cwd: ROOT }).map(String).sort();
    globCache.set(rel, hits);
  }
  return hits;
}
const readCache = new Map<string, string | null>();
function read(rel: string): string | null {
  if (!readCache.has(rel)) {
    const abs = join(ROOT, rel);
    readCache.set(rel, existsSync(abs) ? stripComments(readFileSync(abs, "utf8")) : null);
  }
  const text = readCache.get(rel) ?? null;
  if (text === null) missing.push(rel);
  return text;
}

/** Is the phrase acting as a control LABEL - a short standalone string - rather
 *  than a clause inside a sentence? */
/** Every short piece of USER-VISIBLE text on this line.
 *
 *  String literals (`label="Bin"`, `title="…"`) AND bare JSX text nodes. The
 *  literals-only version missed the commonest React label there is — the text
 *  between the tags:
 *
 *      <NavLink to="/me">
 *        <UserRound size={16} />
 *        Profile              ← not a string literal, so invisible to the lint
 *      </NavLink>
 *
 *  which is how a nav row kept a name the app had already renamed, while a
 *  vocabulary rule watching that exact file stayed green (2026-08-21). */
function visibleText(line: string): string[] {
  const out = stringLiterals(line).map((l) => l.trim());
  const bare = line.trim();
  // A line that is only text — no tags, no braces, no code punctuation — is a
  // JSX text node. Deliberately conservative: `>Label<` on a line with tags is
  // picked up by the second pattern instead.
  if (bare && !/[<>{}();=]/.test(bare)) out.push(bare);
  for (const m of line.matchAll(/>([^<>{}]+)</g)) {
    const t = m[1]!.trim();
    if (t) out.push(t);
  }
  // Text that follows a tag and runs to the end of the line, the closing tag
  // being on the next one:  `<ArrowLeft size={14} /> Profile`
  const trailing = line.match(/>([^<>{}]+)$/);
  if (trailing?.[1]?.trim()) out.push(trailing[1].trim());
  return out;
}

function usedAsLabel(line: string, phrase: RegExp): boolean {
  return visibleText(line).some(
    (t) => phrase.test(t.toLowerCase()) && t.replace(/[….?!]/g, "").length <= 24,
  );
}

// Every row written is a row loaded. Rows are appended at the same place by
// parallel branches, and a merge that drops a row's closing `},` joins it to
// the next: the object keeps the LAST id, so a whole capability stopped being
// checked while this lint stayed green (a floor-plan rebase, 2026-09-29).
// TypeScript would call that a duplicate key, but nothing typechecks scripts.
{
  const written = [...readFileSync(join(ROOT, "scripts/capabilities.ts"), "utf8").matchAll(/^ {4}id: "([^"]+)"/gm)].map((m) => m[1]!);
  const loaded = new Set(CAPABILITIES.map((c) => c.id));
  const lost = written.filter((id) => !loaded.has(id));
  if (lost.length || written.length !== CAPABILITIES.length) {
    console.error(
      `lint:capabilities ✗ scripts/capabilities.ts writes ${written.length} rows but ${CAPABILITIES.length} load` +
        (lost.length ? `; lost: ${lost.join(", ")}` : "") +
        ". A row is missing its closing `},` (a merge joined it to the next), or two rows share an id.",
    );
    process.exit(1);
  }
}

for (const cap of CAPABILITIES) {
  if (cap.kind === "owns") {
    if (!existsSync(join(ROOT, cap.owner))) missing.push(cap.owner);
    for (const rel of Object.keys(cap.except ?? {})) {
      if (!existsSync(join(ROOT, rel))) missing.push(`${rel} (an exemption for ${cap.id} whose file is gone)`);
    }
    for (const rel of expand(cap.scope)) {
      if (rel === cap.owner || cap.except?.[rel]) continue;
      const code = read(rel);
      if (code === null) continue;
      // A two-line copy: the per-line hit counts only where the other half is.
      if (cap.also && !cap.also.test(code)) continue;
      code.split("\n").forEach((line, i) => {
        if (!cap.detect.test(line)) return;
        failures.push({ file: rel, line: i + 1, cap, detail: line.trim().slice(0, 110), fix: cap.use });
      });
    }
  } else if (cap.kind === "requires-prop") {
    for (const rel of expand(cap.scope)) {
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
    for (const rel of expand(cap.scope)) {
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
