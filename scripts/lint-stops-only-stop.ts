#!/usr/bin/env tsx
// An action that declares effect stops can only bring a machine toward stopped: its choices offer only stop, abort, pause or cancel, and its description promises nothing that starts, resumes, moves or heats.
//
// THE BUG THIS PREVENTS. Stop got its own action that runs without a confirm
// on every AI door (#5091): an emergency stop that waits for a Confirm press
// is a stop that comes late. That is safe only while the action cannot do
// anything else. A `stops` action that could also resume, frame or home would
// start a machine on an assistant's word, with nobody asked.
//
// THE RULE. In a module manifest, an action declaring `effect: "stops"`:
//   - offers in any `choices` only stop, abort, pause or cancel;
//   - has a description that names no start, resume, frame, home, jog, move,
//     heat, preheat, send or print, except as what it never does ("Never
//     starts a machine" passes).
// There is no opt-out: an action that needs another verb is not a `stops`
// action, and declares `physical`, which asks a person first.
//
// THE BOUNDARY. Only the declaration is read. The handler is held by the test
// beside the action (a running laser is stopped, and a resume through it is
// refused); a text scan cannot see what a handler sends a driver.
//
//   npx tsx scripts/lint-stops-only-stop.ts   (pnpm lint stops-only-stop)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { manifestSources } from "./lib/manifest-sources.ts";

const ALLOWED = new Set(["stop", "abort", "pause", "cancel"]);
const FORBIDDEN = /\b(start(?:s|ed|ing)?|resum(?:e|es|ed|ing)|frame[sd]?|framing|hom(?:e|es|ed|ing)|jog(?:s|ged|ging)?|mov(?:e|es|ed|ing)|heat(?:s|ed|ing)?|preheat\w*|send(?:s|ing)?|print(?:s|ed|ing)?)\b/i;
const NEGATION = /\b(never|not|cannot|can't|won't|does not|doesn't)\b(\s+\S+){0,6}/gi;

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Each action declaration in a manifest: from its `id:` to the next one. */
function actionBlocks(src: string): Array<{ id: string; text: string; line: number }> {
  const out: Array<{ id: string; text: string; line: number }> = [];
  const re = /\bid:\s*"([a-z0-9-]+:[a-z0-9-]+)"/g;
  const hits = [...src.matchAll(re)];
  hits.forEach((m, i) => {
    const start = m.index!;
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : src.length;
    out.push({ id: m[1]!, text: src.slice(start, end), line: src.slice(0, start).split("\n").length });
  });
  return out;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  for (const b of actionBlocks(src)) {
    if (!/\beffect:\s*"stops"/.test(b.text)) continue;
    for (const c of b.text.matchAll(/choices:\s*\[([^\]]*)\]/g)) {
      for (const v of c[1]!.matchAll(/"([a-z_]+)"/g)) {
        if (!ALLOWED.has(v[1]!)) out.push({ file, line: b.line, what: `${b.id} declares stops but offers "${v[1]}"` });
      }
    }
    const desc = /description:\s*"((?:[^"\\]|\\.)*)"/.exec(b.text)?.[1] ?? "";
    const said = desc.replace(NEGATION, " ");
    const verb = FORBIDDEN.exec(said)?.[1];
    if (verb) out.push({ file, line: b.line, what: `${b.id} declares stops but its description says it can "${verb}"` });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  let judged = 0;
  for (const mod of readdirSync("modules")) for (const file of manifestSources(join("modules", mod))) {
    const src = readFileSync(file, "utf8");
    judged += actionBlocks(src).filter((b) => /\beffect:\s*"stops"/.test(b.text)).length;
    violations.push(...check(file, src));
  }
  if (violations.length) {
    console.error(`[lint:stops-only-stop] ✗ ${violations.length} stops action(s) that could do more than stop:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A stops action runs with no one asked. Keep it to stop, abort, pause or cancel, or declare it physical.");
    process.exit(1);
  }
  console.log(`[lint:stops-only-stop] ✓ ${judged} stops action(s), each only stopping`);
}
