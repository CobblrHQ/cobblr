#!/usr/bin/env tsx
// Every AI provider adapter must declare `promptFingerprint`.
//
//   npx tsx scripts/lint-ai-prompt-fingerprint.ts     (npm run lint:prompt-fingerprint)
//
// WHY THIS IS A LINT AND NOT A CONVENTION: the AI cache keys on
// {capability, provider, model, input}. For identify-image / extract-text /
// match-to-catalog / summarise the PROMPT is not in `input` — the adapter injects
// it. An adapter that doesn't declare `promptFingerprint` therefore keys its
// replies WITHOUT the prompt, so editing that prompt invalidates nothing and every
// image already in the cache keeps returning the answer the OLD prompt produced.
// Forever: cache rows have no TTL.
//
// It is a silent failure. Nothing errors, nothing logs, the numbers just quietly
// describe a prompt you no longer ship — including in the prompt-eval harness,
// whose entire job is to tell you whether a prompt change helped. The only way to
// notice is to already know. So: a lint, not a note in a doc.
//
// The fix is one line — `promptFingerprint,` from ./prompt-fingerprint.js.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "modules", "core-ai", "src", "providers");

const offenders: string[] = [];
for (const name of readdirSync(DIR)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
  const file = join(DIR, name);
  const src = readFileSync(file, "utf8");
  // A provider ADAPTER is a file that declares an AiProviderDef with capabilities.
  const isAdapter = /capabilities:\s*(SUPPORTED|\{)/.test(src) && /invoke:\s*async/.test(src);
  if (!isAdapter) continue;
  if (/promptFingerprint/.test(src)) continue;
  offenders.push(relative(ROOT, file));
}

if (offenders.length === 0) {
  console.log("[lint:prompt-fingerprint] ✓ every AI provider adapter folds its injected prompt into the cache key.");
  process.exit(0);
}

console.error(
  `\n[lint:prompt-fingerprint] ✗ ${offenders.length} provider adapter(s) don't declare promptFingerprint — their cached replies are keyed WITHOUT the prompt, so editing a prompt will invalidate nothing and they'll serve stale answers forever (no TTL):`,
);
for (const f of offenders) console.error(`  ${f}`);
console.error(
  `\nAdd it beside \`capabilities\`:\n` +
    `  import { promptFingerprint } from "./prompt-fingerprint.js";\n` +
    `  …\n  capabilities: SUPPORTED,\n  promptFingerprint,\n` +
    `\nA provider whose prompts genuinely differ supplies its own.\n` +
    `See modules/core-ai/src/providers/prompt-fingerprint.ts`,
);
process.exit(1);
