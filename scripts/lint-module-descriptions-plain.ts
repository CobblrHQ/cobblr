#!/usr/bin/env tsx
// A module's description is shown to people on the apps page, so it says what
// the module does for them in plain words: no internal nouns (polymorphic,
// entity, module, primitive, resolver, registry, kernel, schema) and no code.
//
// THE BUG THIS PREVENTS. The All apps page puts every manifest's top-level
// `description` under the app's name (#4046). The manifests had been written
// for the people building the platform, so a workspace owner read
// "Parts, locations, categories, stock tracking, polymorphic allocations. The
// generalised toolkit you'd otherwise Frankenstein from a spreadsheet", and
// "A polymorphic location_id any module can reference" under Locations
// (2026-09-29).
//
// THE RULE. The first `description:` at the manifest's top level (two spaces
// in, inside defineModule) in modules/<name>/src/module.ts may not contain a
// word from JARGON, a snake_case identifier, a call like `foo()` or a version
// like v0.3. It must also end in a full stop, since the card reads it as a
// sentence. There is no opt-out: a description that needs one of these words
// is describing the machinery, and the card is not the place for it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the TOP-LEVEL
// description. Intents, settings and actions carry their own `description`
// fields (four or more spaces in) that the AI and the settings forms read,
// and several legitimately name a field like `location_id` for the model;
// the first cut of the pattern matched every line and flagged 60 of those.
// "App" and "workspace" are the words people use, so they pass.
//
//   npx tsx scripts/lint-module-descriptions-plain.ts   (pnpm lint module-descriptions-plain)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const JARGON =
  /\b(polymorphic|entit(y|ies)|modules?|primitives?|resolvers?|registry|registries|kernel|schemas?|substrate|rollups?|intents?|manifests?|payloads?|endpoints?|webhooks? payload|crud|jsonb|uuid|frankenstein)\b/i;
const CODE = /\b[a-z]+_[a-z0-9_]+\b|\b[a-zA-Z]+\(\)|\bv\d+\.\d+/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The top-level description's text, joining `"a" + "b"` pieces, and the line it starts on. */
export function topDescription(src: string): { text: string; line: number } | null {
  const m = /^ {2}description:\s*((?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)\s*\+?\s*)+)/m.exec(src);
  if (!m || m.index === undefined) return null;
  const pieces = [...(m[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)];
  const text = pieces.map((p) => p[1] ?? p[2] ?? p[3] ?? "").join("");
  return { text, line: src.slice(0, m.index).split("\n").length };
}

export function check(file: string, src: string): Violation[] {
  const d = topDescription(src);
  if (!d) return [{ file, line: 1, what: "no top-level description: the apps page shows a blank card" }];
  const out: Violation[] = [];
  const jargon = JARGON.exec(d.text);
  if (jargon) out.push({ file, line: d.line, what: `"${jargon[0]}" is a word for the people who build it, not the people who use it` });
  const code = CODE.exec(d.text);
  if (code) out.push({ file, line: d.line, what: `"${code[0]}" is code, not words` });
  if (!/[.!?]$/.test(d.text.trim())) out.push({ file, line: d.line, what: "does not end as a sentence" });
  return out;
}

const violations: Violation[] = [];
for (const name of readdirSync("modules")) {
  const file = join("modules", name, "src", "module.ts");
  if (existsSync(file)) violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:module-descriptions-plain - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Rewrite it as one plain sentence about what it does for you, the way the apps page reads it.");
  process.exit(1);
}
console.log(`lint:module-descriptions-plain OK`);
