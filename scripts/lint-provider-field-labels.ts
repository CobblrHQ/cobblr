// Provider-field-label lint. A GENERIC / bring-your-own AI provider's user-facing
// credential-field copy must describe the generic CAPABILITY, not a specific
// hosted AI product. (prevent-recurrence guardrail: shipped alongside the fix for
// an `mcp_relay` field that read "Is this a Claude-subscription bridge?" — naming
// one specific bridge in a field every local-AI connection renders. That
// violates Cobblr's "generic, never use-case/product-shaped" rule.)
//
// The class: a field `label:` (or a choice `label:`) in a generic/local provider
// names a specific hosted product. We scan the AI provider source for `label:`
// string literals containing a denylisted product term. The VENDOR-SPECIFIC
// providers (anthropic, openai, openrouter) legitimately name their own vendor,
// so they're exempt. Comments are NOT scanned (only `label:` strings), so an
// internal "// …claude bridge…" note is fine — it never reaches a user.
//
// Extend: add a new provider name to the deny list as products appear; add a new
// vendor-specific provider file to EXEMPT.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDER_DIR = "modules/core-ai/src/providers";

// Files whose provider IS that vendor — naming it in their own fields is correct.
const VENDOR_EXEMPT = new Set(["anthropic.ts", "openai.ts", "openrouter.ts"]);

// Specific hosted-AI products/marketing that must never appear in a GENERIC
// provider's user-facing field copy. NOT "OpenAI"/"Ollama"/"LM Studio" — those
// are the generic providers' own honest names.
const DENY = ["claude", "anthropic", "chatgpt", "gpt-4", "gpt-3", "gemini", "bard", "copilot", "subscription bridge"];

// A `label: "..."` / `label: '...'` / label: `...` string literal, capture inner text.
const LABEL = /label:\s*(["'`])([^"'`]*)\1/;

interface Finding {
  file: string;
  line: number;
  label: string;
  term: string;
}

const found: Finding[] = [];
let files: string[] = [];
try {
  files = readdirSync(PROVIDER_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
} catch {
  console.error(`[lint:provider-labels] provider dir not found: ${PROVIDER_DIR}`);
  process.exit(1);
}

for (const f of files) {
  if (VENDOR_EXEMPT.has(f)) continue;
  const path = join(PROVIDER_DIR, f);
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const m = LABEL.exec(line);
      if (!m) return;
      const text = m[2]!.toLowerCase();
      const term = DENY.find((d) => text.includes(d));
      if (term) found.push({ file: path, line: i + 1, label: m[2]!, term });
    });
}

if (found.length > 0) {
  console.error(
    `✗ provider-field-label lint: ${found.length} generic AI provider field label(s) name a specific product:\n`,
  );
  for (const v of found) console.error(`  ${v.file}:${v.line}  "${v.label}"  (has "${v.term}")`);
  console.error(
    `\nA generic / bring-your-own AI provider's field copy must describe the generic
CAPABILITY, not a specific hosted product. e.g. NOT "Is this a Claude-subscription
bridge?" but "How this AI runs tools" with a generic choice. Naming one product in
a field every user sees violates the "generic, never use-case-shaped" rule
(see .claude/skills/code-contribution + prevent-recurrence). If the file is itself
a vendor-specific provider, add it to VENDOR_EXEMPT in this lint.`,
  );
  process.exit(1);
}

console.log(`[lint:provider-labels] ${files.length - VENDOR_EXEMPT.size} generic provider(s) clean.`);
