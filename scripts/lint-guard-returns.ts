// Guard: a one-line `if` that sends a response must not fall through.
//
//   if (!token) res.status(400).json({ … });     // ← sends, then KEEPS GOING
//
// Express does not stop a handler when you write a response, so this guard
// answers the request and then runs the rest of the handler anyway: another
// database round trip on input already rejected, and then a second `res.…` that
// throws ERR_HTTP_HEADERS_SENT into the error log. The caller sees the right
// status, so the bug is invisible from outside — it shows up only as unexplained
// 500s next to successful requests, which is the worst place to find it.
//
// Real instance: GET /try/redeem with no token. Anything scanning URLs hits it,
// on the one box that hands out anonymous databases, where a readable error log
// is the whole safety story.
//
// The shape is what makes this checkable: an UNBRACED if body can only hold one
// statement, so if that statement is the send, there is nowhere to put the
// `return`. Braces (`if (x) { res…; return; }`), an explicit `return res.…`, and
// an if/else where both arms answer are all correct and not flagged.
//
// Non-terminating calls are fine and ignored: `res.setHeader(…)`, `res.type(…)`
// and friends decorate a response that is still going to be sent later.
//
// Run: npx tsx scripts/lint-guard-returns.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules"];
/** Calls that END the response. Everything else only decorates it. */
const TERMINATORS = [".json(", ".send(", ".end(", ".redirect(", ".sendStatus(", ".render(", ".sendFile("];
/** An unbraced if whose body starts with a response call.
 *
 *  The condition is matched greedily rather than as "no closing paren", because
 *  nearly every real guard CALLS something — `if (!sandboxEnabled()) res.…` — and
 *  a non-greedy match stops at that call's own paren and silently skips the line.
 *  Greedy takes the LAST `)` before `res.`, which is the if's own. (This lint
 *  missed three of the four bugs it was written for until it was fixed.) */
const UNBRACED_IF = /^\s*if\s*\(.*\)\s*res\s*\./;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

function main(): void {
  const problems: string[] = [];
  let scanned = 0;

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      scanned++;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!UNBRACED_IF.test(line)) return;
        if (!TERMINATORS.some((t) => line.includes(t))) return; // decorates, does not answer
        if (/\breturn\b/.test(line)) return; // `if (x) return res.…` — fine

        // `if (x) res.json(a); else res.status(204).end();` — both arms answer
        // and nothing follows, which is correct.
        const next = lines.slice(i + 1).find((l) => l.trim() !== "");
        if (next && /^\s*(\}\s*)?else\b/.test(next)) return;

        problems.push(
          `  ${file}:${i + 1}\n      ${line.trim()}\n` +
            `      → this answers the request and then carries on. Wrap it:  if (…) { …; return; }`,
        );
      });
    }
  }

  if (problems.length > 0) {
    console.error(`✗ response sent without returning:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`✓ guard returns: ${scanned} files, no handler answers a request and keeps going`);
}

main();
