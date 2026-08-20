#!/usr/bin/env tsx
// An action a PERSON can ask for must say how they would ask.
//
// The action list an assistant is handed is ids and labels. It says what
// exists, and not what a request for it sounds like, so mapping "used one"
// onto inventory:use-one or "that order turned up" onto purchases:mark-arrived
// was left to the model to work out from an internal name. That is the one
// thing the manifest can cheaply say and nothing else can.
//
// So EVERY action either carries at least one `examples` entry, or says at the
// action why nobody would ask for it in words:
//
//     // NO-PHRASING: <why>
//
// within six lines above its `id:`.
//
// Wire-only actions were exempt at first, on the reasoning that an event fires
// them so nobody phrases them. That was true of most and wrong about three:
// the bundle-migration engines ARE asked for out loud ("move the Room field
// into Location"), they were simply marked wire-only because a wire also fires
// them. An exemption by flag hid that, and an absent phrasing looked the same
// whether somebody had decided or nobody had looked. Now the decision is
// always written down, and the cost of writing it is one line.
//
//   cd <repo> && npx tsx scripts/lint-action-examples.ts

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODULES = "modules";
const LOOKBACK = 6;
const EXEMPT = /NO-PHRASING:/;

interface Finding {
  id: string;
  where: string;
  label: string;
}

const findings: Finding[] = [];
let checked = 0;
let withExamples = 0;

for (const mod of readdirSync(MODULES)) {
  const manifest = join(MODULES, mod, "src", "module.ts");
  if (!existsSync(manifest)) continue;
  const src = readFileSync(manifest, "utf8");
  const lines = src.split("\n");
  const ids = [...src.matchAll(/^\s*id: "([a-z0-9-]+:[a-z0-9-]+)",$/gm)];

  for (const [i, m] of ids.entries()) {
    const block = src.slice(m.index!, i + 1 < ids.length ? ids[i + 1]!.index! : src.length);
    // An action, not an entity kind or a live control.
    if (!/invokeHandler:|invokeRoute:/.test(block)) continue;
    checked++;
    if (/examples:\s*\[/.test(block)) {
      withExamples++;
      continue;
    }
    const lineNo = src.slice(0, m.index!).split("\n").length;
    const above = lines.slice(Math.max(0, lineNo - 1 - LOOKBACK), lineNo - 1).join("\n");
    if (EXEMPT.test(above)) continue;
    findings.push({
      id: m[1]!,
      where: `${manifest}:${lineNo}`,
      label: block.match(/label: "([^"]*)"/)?.[1] ?? "",
    });
  }
}

if (findings.length > 0) {
  console.error(`✗ action-examples lint: ${findings.length} action(s) with no phrasing and no reason given.\n`);
  for (const f of findings) console.error(`  ${f.id}${f.label ? ` — ${f.label}` : ""}\n      ${f.where}`);
  console.error(`
Add the words somebody would actually use, not a restatement of the label:

    examples: ["used one", "I just took one out"],

Three at most, short: they ride in every chat prompt. If nobody would ever ask
for it in words (an event fires it, it is a deprecated alias, it acts on
whatever triggered it), say why instead, above the action's id:

    // NO-PHRASING: <why>

An action fired by a wire can still be asked for. Two of the bundle-migration
engines are exactly that, so being wire-fired is not on its own a reason.`);
  process.exit(1);
}

console.log(
  `✓ action-examples lint: all ${checked} action(s) accounted for (${withExamples} with phrasings, ${checked - withExamples} explained).`,
);
