// Guard: every icon a live control declares must actually resolve.
//
// `iconForName` falls back to Plug for a name it does not know. That fallback is
// for an icon we genuinely have not seen — a hosted panel sending something new
// — but it silently swallowed the ones we ship. Every live control in the repo
// declared an icon the map had never heard of (`printer` for auto-print,
// `scan-line` for scan-drive), so the Live box rendered a plug for all of them,
// and nothing failed: not the typecheck, not a test, not a runtime warning. It
// simply looked slightly wrong forever.
//
// The failure mode is what makes this worth a check. A missing icon does not
// throw, so the only way to notice is for someone to look at the box and know
// what it was supposed to be.
//
// Run: npx tsx scripts/lint-live-icons.ts

import { readFileSync, globSync } from "node:fs";

const MAP = "web/src/lib/panel-icons.ts";

const known = new Set<string>();
for (const line of readFileSync(MAP, "utf8").split("\n")) {
  // Keys in the ICONS record: `printer: Printer,` or `"scan-line": ScanLine,`
  const m = /^\s*"?([a-z0-9-]+)"?\s*:\s*[A-Z]\w*\s*,/.exec(line);
  if (m?.[1]) known.add(m[1]);
}
if (known.size === 0) {
  console.error(`live-icons lint: parsed no icon names out of ${MAP} — the check would pass vacuously.`);
  process.exit(1);
}

// Icons declared on a live control, wherever they are declared: a module
// manifest's live block, or a client-side control built in the web app.
const declared: Array<{ file: string; line: number; icon: string }> = [];
const files = [...globSync("modules/*/src/module.ts"), ...globSync("web/src/components/LiveBox.tsx")];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    // Only icons that sit on a live CONTROL — a control literal carries
    // `control:` (switch / switch-segment) on the same line, or an `icon:` in a
    // block that also declares `requires:`/`scope:`. Keep it simple and precise:
    // match an icon next to a control/scope declaration within a few lines.
    const m = /\bicon:\s*(?:byScans\s*\?\s*)?["']([a-z0-9-]+)["']/.exec(t);
    if (!m?.[1]) return;
    const near = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
    if (!/\b(control:|scope:\s*["']tab|liveControls|live:)/.test(near)) return;
    declared.push({ file, line: i + 1, icon: m[1] });
    // A ternary can name two icons on one line.
    const second = /\bicon:\s*byScans\s*\?\s*["'][a-z0-9-]+["']\s*:\s*["']([a-z0-9-]+)["']/.exec(t);
    if (second?.[1]) declared.push({ file, line: i + 1, icon: second[1] });
  });
}

const missing = declared.filter((d) => !known.has(d.icon));
if (missing.length > 0) {
  console.error(`live-icons lint: a live control declares an icon ${MAP} does not know.\n`);
  for (const m of missing) console.error(`    ❌ ${m.file}:${m.line}  icon: "${m.icon}"`);
  console.error(
    `\n  It will render the Plug fallback — silently, with nothing failing.` +
      `\n  Add it to the ICONS record in ${MAP}:` +
      `\n      import { Foo } from "lucide-react";  →  "${missing[0]!.icon}": Foo,`,
  );
  process.exit(1);
}

console.log(`live-icons lint: ${declared.length} declared live icon(s), all resolve ✓`);
