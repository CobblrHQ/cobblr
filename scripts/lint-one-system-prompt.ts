#!/usr/bin/env tsx
// The system prompt is assembled in exactly one place.
//
// THE BUG THIS PREVENTS. The chat route used to finish what the prompt builder
// started: `system += pageContextLine(...)` and `system += selectionLine(...)`
// after buildSystemPrompt had returned. Anything else that built a prompt
// through the same builder - the action bench - therefore sent a prompt the
// app does not send, and did not know it.
//
// It cost a week of nightly runs. Asked "save this as a board", the bench's
// model had no board and no "this": the app tells it which screen the user is
// looking at, the bench did not. The honest answer in words was scored as a
// miss, twice a night, and the fix looked like a model problem.
//
// This is the second time the same class has been paid for. The first was the
// bench's own six-line stand-in prompt, which reported six "described instead
// of acting" misses the app never had (2026-09-04) and produced
// api/../system-prompt.ts. Extracting the builder was not enough on its own,
// because a caller could still append to what it returned.
//
// THE RULE. Only modules/core-ai/src/api/system-prompt.ts may append to a
// system prompt. A situational sentence belongs in a function that builder
// calls (see situationalSuffix), so every caller gets it for free.
//
//   cd <repo> && npx tsx scripts/lint-one-system-prompt.ts

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules", "scripts", "packages"];
const OWNER = "modules/core-ai/src/api/system-prompt.ts";
const SKIP = /(\/dist\/|\/node_modules\/|\.test\.|\.spec\.)/;
/** `system += …`, `systemPrompt = systemPrompt + …`, and the template form. */
const APPEND = /^\s*(?:const|let)?\s*\b(system|systemPrompt|prompt)\b\s*(?:\+=|=\s*(?:`?\$\{)?\1\s*\+)/;

const findings: string[] = [];

function walk(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (SKIP.test(full)) continue;
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    if (full.endsWith(OWNER)) continue;
    readFileSync(full, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (APPEND.test(line)) findings.push(`  ${full}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
  }
}

for (const root of ROOTS) walk(root);

if (findings.length) {
  console.error(`✗ one-system-prompt lint: ${findings.length} place(s) adding to a system prompt outside the builder\n`);
  console.error(findings.join("\n"));
  console.error(
    `\nA prompt assembled in two places is a prompt that differs between callers, and the\n` +
      `one that measures the product is the caller that finds out last. Put the sentence in\n` +
      `${OWNER} - a helper the builder calls, like situationalSuffix - and pass what it needs\n` +
      `through PromptOptions instead.\n`,
  );
  process.exit(1);
}
console.log("lint:one-system-prompt ✓ the system prompt is assembled in one place.");
