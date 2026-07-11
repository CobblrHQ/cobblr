#!/usr/bin/env tsx
// AI-invoke caller lint — every `platform().ai.invoke({...})` must pass `userId`.
//
// Why: invoke resolves a USER-SCOPED personal AI connection (bring-your-own
// creds routed by that user) only when it knows the caller. Omit userId and the
// call silently falls through to the workspace/managed provider (+ its
// entitlement gate) and, when nothing resolves, to the no-AI branch. Org-scoped
// routes resolve either way, so the omission hides until someone routes a cred
// user-scoped — then a feature "has no AI" for no visible reason. This exact
// bug hit the put-away planner (and was latent in ~10 call sites). One key,
// easy to forget, no compile-time signal → lint it.
//
//   npx tsx scripts/lint-ai-invoke.ts        (npm run lint:ai-invoke)
//
// A genuinely userless caller (a cron / background job with no request user)
// passes `userId: null` explicitly, OR annotates the call `// ai-userless:
// <reason>`. Either satisfies the lint — the point is that the decision is
// DELIBERATE, never a silent drop. Local + CI, free, no deps beyond fs.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = [join(ROOT, "modules"), join(ROOT, "api", "src"), join(ROOT, "cloud", "src")];

interface Violation {
  file: string;
  line: number;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "tests") continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** From the index of the `{` that opens the invoke argument, return the text of
 *  the whole object literal (through its matching `}`), skipping string and
 *  template-literal contents so braces inside prose don't miscount. */
function objectLiteral(src: string, openBrace: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i]!;
    const prev = src[i - 1];
    if (quote) {
      if (c === quote && prev !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  return src.slice(openBrace); // unbalanced — treat as the rest (will fail the check)
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const call = /\.ai\.invoke\(\s*\{/g;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");
      call.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = call.exec(src)) !== null) {
        const openBrace = src.indexOf("{", m.index);
        if (openBrace < 0) continue;
        const arg = objectLiteral(src, openBrace);
        const line = src.slice(0, m.index).split("\n").length;
        // Opt-out: the call literal, or a comment within ~4 lines above it,
        // carries an ai-userless marker → a deliberate userless call.
        let above = m.index;
        for (let k = 0; k < 4; k++) {
          const p = src.lastIndexOf("\n", above - 1);
          if (p < 0) {
            above = 0;
            break;
          }
          above = p;
        }
        const window = src.slice(above, openBrace + arg.length);
        if (/ai-userless/.test(window)) continue;
        // The one requirement: a userId key is present — `userId:` (any value,
        // incl. null) OR the ES shorthand `userId,` / `userId }`.
        if (/\buserId\s*[:,}]/.test(arg)) continue;
        violations.push({ file: rel, line });
      }
    }
  }
  return violations;
}

const violations = scan();
if (violations.length === 0) {
  console.log("[lint:ai-invoke] ✓ every ai.invoke passes userId (or is annotated ai-userless).");
  process.exit(0);
}
console.error(
  `\n[lint:ai-invoke] ✗ ${violations.length} ai.invoke call(s) missing userId — pass the requesting user ` +
    `so a user-scoped personal AI connection resolves. For a genuinely userless caller (cron/background), ` +
    `pass \`userId: null\` or annotate the call \`// ai-userless: <reason>\`:`,
);
for (const v of violations) console.error(`  ${v.file}:${v.line}`);
console.error("");
process.exit(1);
