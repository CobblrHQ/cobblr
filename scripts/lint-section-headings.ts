// A section heading inside the app looks like the app's section headings.
//
// Reported as "the tags section looks weird". It was: on one screen, the
// locations page wrote its section headings as
//
//     text-[10px] font-mono uppercase tracking-widest text-accent      // what's here
//
// and the shared attachments component wrote its own as
//
//     text-xs font-medium text-muted uppercase tracking-wide           Tags
//
// Different family entirely — proportional instead of mono, muted instead of
// accent, tracking-wide instead of tracking-widest, no `//` prefix. 38 files
// used the first; exactly one used the second. It read as a foreign element
// dropped into the page, which is precisely what it was.
//
// This rule is deliberately about the FAMILY, not the exact class string. Five
// headings legitimately vary the size (text-xs, text-[11px], text-sm) for
// denser or more prominent sections, and that reads fine because everything
// else matches. What does not read fine is a heading from a different type
// system. So: mono + uppercase + wide tracking, or use SettingsSection.
//
// Same failure mode as the page headers: each heading looks fine alone, and the
// mismatch only shows when two sit on one screen. That is what a user sees and
// a reviewer does not.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEB = join(ROOT, "web/src");

/** The section-heading family: monospace, uppercase, opened-up tracking. */
const FAMILY = (cls: string) =>
  /\bfont-mono\b/.test(cls) && /\buppercase\b/.test(cls) && /\btracking-wide(st)?\b/.test(cls);

/** Card-title headings (SettingsSection and its shape) are a different, equally
 *  deliberate thing: sentence case, semibold, no tracking. Not section rules. */
const CARD_TITLE = (cls: string) => /\btext-(sm|base|lg)\b/.test(cls) && /\bfont-semibold\b/.test(cls);

const files = globSync("**/*.tsx", { cwd: WEB }).filter((f) => !f.includes("__tests__"));

const bad: Array<{ file: string; line: number; cls: string }> = [];

for (const rel of files) {
  const src = readFileSync(join(WEB, rel), "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/<h[23] className="([^"]*)"/);
    if (!m) continue;
    const cls = m[1]!;
    // Only headings that SHOUT are section rules; a plain sentence-case h2 is a
    // card title and is judged by CARD_TITLE.
    if (!/\buppercase\b/.test(cls)) continue;
    if (FAMILY(cls) || CARD_TITLE(cls)) continue;
    bad.push({ file: rel, line: i + 1, cls: cls.slice(0, 70) });
  }
}

if (bad.length) {
  console.error("[lint:section-headings] section heading from a foreign type family:\n");
  for (const b of bad) {
    console.error(`  web/src/${b.file}:${b.line}`);
    console.error(`      className="${b.cls}"`);
  }
  console.error(`
  The app writes a section rule as monospace + uppercase + wide tracking:

      <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">
        // tags
      </h3>

  Size may vary for a denser or more prominent section. The TYPE FAMILY may not:
  a proportional, muted, tracking-wide heading beside a mono one reads as
  something that wandered in from another app.

  For a bordered card with a title, use <SettingsSection> instead.
`);
  process.exit(1);
}

console.log("[lint:section-headings] ok — every uppercase section heading uses the app's family.");
