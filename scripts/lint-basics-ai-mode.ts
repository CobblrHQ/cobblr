// Cobb's written-down answers are shown in BOTH worlds now: the send path only
// runs with no provider, but the pre-send peek runs in connected workspaces
// too. So a reply that asserts the no-AI state ("without AI connected I cannot
// act on your workspace") is a false statement the moment someone connects a
// provider, unless the rule says so.
//
// This lint fails on a catalog rule whose prose claims the no-AI state without
// either `notBeforeSend: true` (a reply, never an offer) or `replyWhenAiOn`
// (offer this wording instead). Adding a rule is a two-line data edit that
// looks harmless, which is exactly why it needs a check rather than a memory.
import { readFileSync } from "node:fs";

const FILE = "modules/core-ai/src/basics-catalog.ts";
const src = readFileSync(FILE, "utf8");

// Prose that only holds when no provider is connected.
const CLAIMS_NO_AI =
  /(without AI connected|with no AI connected|no AI connected|AI (?:chat )?isn't connected|need(?:s)? AI connected|Connect AI (?:using|and))/i;

const failures: string[] = [];
// Each rule is an object literal in the exported array; split on the key line.
const parts = src.split(/\n  \{\n/).slice(1);
for (const part of parts) {
  const body = part.split(/\n  \},/)[0] ?? part;
  const key = /key: "([^"]+)"/.exec(body)?.[1];
  if (!key) continue;
  const reply = /reply:\s*([\s\S]*?)(?:\n    \w+:|$)/.exec(body)?.[1] ?? "";
  // A reply built from a const (CAPABILITIES) is checked at its definition.
  const constName = /^\s*([A-Z_]+),\s*$/.exec(reply)?.[1];
  const text = constName
    ? (new RegExp(`const ${constName} = \`([\\s\\S]*?)\`;`).exec(src)?.[1] ?? "")
    : reply;
  if (!CLAIMS_NO_AI.test(text)) continue;
  if (/notBeforeSend: true/.test(body)) continue;
  if (/replyWhenAiOn/.test(body)) continue;
  failures.push(key);
}

// The consts themselves: a no-AI variant must have a connected-world twin.
for (const m of src.matchAll(/const ([A-Z_]+) = `([\s\S]*?)`;/g)) {
  const [, name, text] = m;
  if (!name || !text || name.endsWith("_AI")) continue;
  if (!CLAIMS_NO_AI.test(text)) continue;
  if (!src.includes(`const ${name}_AI`)) failures.push(`${name} (no ${name}_AI twin)`);
}

if (failures.length) {
  console.error(`[lint:basics-ai-mode] ${failures.length} reply(ies) claim "no AI connected" with no mode declared:`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\n  Cobb shows these before a message is sent, in workspaces that DO have AI.\n" +
      "  Add `notBeforeSend: true` (a reply, never an offer) or `replyWhenAiOn: \"…\"` (say it differently).",
  );
  process.exit(1);
}
console.log("[lint:basics-ai-mode] ✓ every no-AI reply declares its mode");
