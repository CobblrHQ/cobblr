// A reply to a reporter must not claim the fix is deployed.
//
// Merging is not shipping. A self-hoster gets a fix with the next nightly and
// the hosted service with the next release, and neither has happened at the
// moment somebody resolves an item. The API used to prepend "Fixed — this is
// live now" to every resolution, including ones whose author had written the
// accurate timing themselves, so the reporter read a contradiction and the
// author had no way to prevent it.
//
// The fix was to route every reply through feedbackReplyText(). This stops the
// next one being added: there were FOUR copies of the claim, spelled two
// different ways ("Fixed —" and "Fixed,"), and a grep for one of them missed
// the other. A test cannot catch a fifth site that never calls the function.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules"];
const ALLOW = ["api/src/platform/feedback-reply-text.ts"]; // defines the defaults

// Phrases that assert a deployment has happened. Matched loosely on purpose:
// the point is to catch a NEW spelling, and the two that existed differed only
// by a comma.
const CLAIMS = [/\bis live now\b/i, /\bnow live\b/i, /\bdeployed now\b/i, /\bavailable now\b/i];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(p) && !/\.test\./.test(p)) out.push(p);
  }
  return out;
}

const hits: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (ALLOW.some((a) => file.endsWith(a) || file === a)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Only a string LITERAL counts. A comment explaining the history is fine
      // and the fix itself carries one.
      const withoutComment = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (!/["'`]/.test(withoutComment)) return;
      if (CLAIMS.some((c) => c.test(withoutComment))) hits.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
}

if (hits.length) {
  console.error("[lint:reply-no-deploy-claim] ✗ a reply claims the fix is deployed:\n");
  for (const h of hits) console.error(`  ${h}`);
  console.error(`
Merging is not shipping. At the moment an item is resolved, a self-hoster has
not received the fix (it arrives with the next nightly) and neither has the
hosted service (the next release). Saying otherwise is wrong, and prepending it
to a reply somebody wrote makes THEIR accurate sentence wrong too.

Send what the resolver wrote, via feedbackReplyText() in
api/src/platform/feedback-reply-text.ts, which adds nothing in front of it.`);
  process.exit(1);
}
console.log("[lint:reply-no-deploy-claim] ✓ no reply claims a deployment that has not happened");
