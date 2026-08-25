// Guard: there is ONE private/link-local IP predicate in the whole platform —
// packages/platform-contract/src/private-ip.ts — and every SSRF guard imports
// it. No file may define its OWN.
//
// The trap this catches: the rule had grown FIVE copies (kernel egress, the
// sandbox, the integrations webhook guard, the scan image guard, the digifab
// driver guard) and they had DRIFTED — the kernel knew the Tailscale CGNAT range
// (100.64/10) but not multicast, the sandbox the reverse, two knew neither — so
// a hostname resolving into the tailnet was blocked by one path and waved
// through by another. A whole class of SSRF bypass. See
// docs/history/2026-08-25-prerelease-audit.md B2.
//
// A re-export (`export const isPrivate = isPrivateIp`) is fine — it aliases the
// canonical one. What is forbidden is a real DEFINITION (a function or an
// arrow/function assignment) of one of these names anywhere else.
// Run: npx tsx scripts/lint-one-private-ip.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = "packages/platform-contract/src/private-ip.ts";
const SCAN_DIRS = ["api/src", "modules", "packages"];
const NAMES = ["isPrivateIp", "isPrivate", "isDangerousIp", "isLinkLocalIp", "isLinkLocal"];

// A DEFINITION: `function isPrivateIp(` OR `isPrivateIp = (` / `= function` /
// `= async`. A re-export `= isPrivateIp;` (an identifier) does not match.
const DEF = new RegExp(
  `\\b(?:function\\s+(?:${NAMES.join("|")})\\b)|\\b(?:${NAMES.join("|")})\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b)`,
);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist" || e === ".git") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
}

const files: string[] = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);

const offenders: string[] = [];
for (const abs of files) {
  const rel = relative(ROOT, abs);
  if (rel === CANONICAL) continue;
  const text = readFileSync(abs, "utf8");
  for (const line of text.split("\n")) {
    if (DEF.test(line)) {
      offenders.push(`${rel}: ${line.trim()}`);
      break;
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `lint:one-private-ip — a private/link-local IP predicate is defined outside the canonical file.\n` +
      `Import from @cobblr/platform-contract/private-ip instead (isPrivateIp / isDangerousIp / isLinkLocalIp);\n` +
      `a second copy will drift from it, which is a whole SSRF bypass class (audit B2).\n`,
  );
  for (const o of offenders) console.error(`  ✗ ${o}`);
  process.exit(1);
}

console.log(`lint:one-private-ip — one predicate, ${files.length} files clean.`);
