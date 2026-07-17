// Guard: temporary debug code doesn't outlive its diagnosis. Two patterns fail
// UI source (web/src, packages/platform-web/src, modules/*/ui):
//   1. a `TEMP DEBUG` marker — the author's own "remove after diagnosis" flag.
//      The class: a marked-temporary probe merges, the diagnosis ends, and the
//      probe ships forever (window.__navDbg outlived its bug by a week).
//   2. an assignment to a dunder window global (`window….__name =`) outside the
//      allowlist — the window-global probe is the debug idiom this repo reaches
//      for, while real dunder bridges are few, named, and allowlisted here.
// Lenient by design: reads never flag, only assignments; single-line matching
// only, so it errs toward NOT flagging.
//
// Run: npx tsx scripts/lint-debug-globals.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const ALLOWED_GLOBALS = new Set([
  "__PUBLIC_DATA__", // PublicAppPlayer srcdoc bridge — the sandboxed page's data seam, not a probe
]);

const ROOTS = ["web/src", "packages/platform-web/src"];
for (const m of readdirSync(join(ROOT, "modules"))) {
  const ui = join(ROOT, "modules", m, "ui");
  try {
    if (statSync(ui).isDirectory()) ROOTS.push(relative(ROOT, ui));
  } catch {
    // module has no ui tree
  }
}

const files: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
for (const r of ROOTS) {
  try {
    walk(join(ROOT, r));
  } catch {
    // root absent in this checkout
  }
}

const failures: string[] = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `${relative(ROOT, f)}:${i + 1}`;
    if (line.includes("TEMP DEBUG")) {
      failures.push(`${at}: TEMP DEBUG marker — remove the probe (or make it a real mechanism) before merging`);
    }
    if (line.includes("window")) {
      const m = line.match(/\.\s*(__[A-Za-z0-9_]+)\s*=(?![=>])/);
      if (m && m[1] && !ALLOWED_GLOBALS.has(m[1])) {
        failures.push(
          `${at}: assignment to window global ${m[1]} — debug probes don't merge; if this is a real runtime bridge, allowlist it in scripts/lint-debug-globals.ts`,
        );
      }
    }
  });
}

if (failures.length) {
  console.error(`[lint:debug-globals] ${failures.length} leftover debug probe(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[lint:debug-globals] OK — ${files.length} UI source files clean`);
