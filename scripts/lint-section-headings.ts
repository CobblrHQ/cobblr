// A section heading inside the app looks like the app's section headings, and
// is written in the app's own face, never the code font.
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
// Different family entirely. It read as a foreign element dropped into the
// page, which is precisely what it was. So one family: uppercase + wide
// tracking, or SettingsSection's card title.
//
// Then the owner, 2026-10-13 (#6337), on a 3D printer's page: "// TAGS",
// "// HISTORY", "// SERVICE SCHEDULE" were the code font in the UI, the class
// #6099 had fixed only for the scan inbox's meta lines. So the family lost the
// code font and the "//": a section heading is uppercase, wide-tracked and
// proportional, and anywhere in the app's UI (web, platform-web, every
// module's ui) a class string with both font-mono and uppercase fails, as does
// JSX text opening with "// ". A real code shown uppercase (an error code, a
// hex) keeps the code font with a `mono: <what it is>` note on its line or the
// line above.
//
// This rule is deliberately about the FAMILY, not the exact class string. Five
// headings legitimately vary the size (text-xs, text-[11px], text-sm) for
// denser or more prominent sections, and that reads fine because everything
// else matches.
//
// Same failure mode as the page headers: each heading looks fine alone, and the
// mismatch only shows when two sit on one screen. That is what a user sees and
// a reviewer does not.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEB = join(ROOT, "web/src");

/** The section-heading family: uppercase, opened-up tracking, the app's own
 *  face (never the code font, #6337). */
const FAMILY = (cls: string) =>
  !/\bfont-mono\b/.test(cls) && /\buppercase\b/.test(cls) && /\btracking-wide(st)?\b/.test(cls);

/** Card-title headings (SettingsSection and its shape) are a different, equally
 *  deliberate thing: sentence case, semibold, no tracking. Not section rules. */
const CARD_TITLE = (cls: string) => /\btext-(sm|base|lg)\b/.test(cls) && /\bfont-semibold\b/.test(cls);

const files = globSync("**/*.tsx", { cwd: WEB }).filter((f) => !f.includes("__tests__"));
/** Each web file read once, for both passes over web/src. */
const sources = new Map<string, string>();
const sourceOf = (rel: string) => {
  let src = sources.get(rel);
  if (src === undefined) sources.set(rel, (src = readFileSync(join(WEB, rel), "utf8")));
  return src;
};

const bad: Array<{ file: string; line: number; cls: string }> = [];

for (const rel of files) {
  const src = sourceOf(rel);
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

// ── Card titles: the second sanctioned family, with a shrink-only baseline ──
//
// A card's title is `text-sm font-semibold` (SettingsSection's shape). The
// drifted settings pages used font-medium, font-display text-lg, and one
// text-xs — none of which any rule sanctioned, which is how four families
// accumulated. 19 pre-existing off-family headings live in the baseline
// (shrink-only, the no-emdash precedent): fixing them is welcome, adding one
// is not. Page titles (font-display text-2xl/xl) belong to the layouts and are
// exempt; uppercase headings are the region-rule family judged above.
const BASELINE_PATH = join(ROOT, "scripts/section-headings-baseline.json");
const baseline = new Set<string>(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
const nowOffFamily: string[] = [];
for (const rel of files) {
  const src = sourceOf(rel);
  for (const m of src.matchAll(/<h[23] className="([^"]*)"/g)) {
    const cls = m[1]!;
    if (/\buppercase\b/.test(cls)) continue;
    if (/\btext-(sm|base)\b.*\bfont-semibold\b|\bfont-semibold\b.*\btext-(sm|base)\b/.test(cls)) continue;
    if (/font-display/.test(cls) && /text-(2xl|xl)\b/.test(cls)) continue;
    nowOffFamily.push(`web/src/${rel}::${cls}`);
  }
}
const fresh = nowOffFamily.filter((k) => !baseline.has(k));
for (const k of fresh) {
  const [file, cls] = k.split("::");
  bad.push({ file: file!.replace("web/src/", ""), line: 0, cls: cls!.slice(0, 70) });
}
if (nowOffFamily.length < baseline.size && fresh.length === 0) {
  console.log(
    `[lint:section-headings] baseline can shrink: ${baseline.size} -> ${nowOffFamily.length} (regenerate scripts/section-headings-baseline.json)`,
  );
}

// ── No code font, no "//", on any uppercase label in the app's UI (#6337) ──
//
// Over every UI root, not only web/src: a module's ui draws on the same pages.
const UI_ROOTS = ["web/src", "packages/platform-web/src", ...globSync("modules/*/src", { cwd: ROOT })];
// git grep picks the files that could offend (the code font, or a // opening
// rendered text or a string), so the pass reads those and not the whole tree.
const candidates = new Set(
  execFileSync("git", ["grep", "--untracked", "-l", "-E", "-e", "font-mono", "-e", "(>|[{][\"`]|[\"'`])// ?[A-Za-z{$]", "--", ...UI_ROOTS], { maxBuffer: 1024 * 1024 * 1024, cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
);
const mono: Array<{ at: string; what: string }> = [];
for (const root of UI_ROOTS) {
  for (const rel of globSync("**/*.{ts,tsx}", { cwd: join(ROOT, root) })) {
    if (/\.test\.tsx?$|__tests__|\/dist\//.test(rel) || !candidates.has(`${root}/${rel}`)) continue;
    const lines = (root === "web/src" && rel.endsWith(".tsx") ? sourceOf(rel) : readFileSync(join(ROOT, root, rel), "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const noted = /mono: \S/.test(line) || /mono: \S/.test(lines[i - 1] ?? "");
      // By line, not by string: a class written as a template over several
      // lines never closes its quote on the line that says font-mono.
      if (!noted && !/^\s*(\/\/|\*)/.test(line) && /\bfont-mono\b/.test(line) && /\buppercase\b/.test(line))
        mono.push({ at: `${root}/${rel}:${i + 1}`, what: "an uppercase label in the code font" });
      const comment = /^\s*(\/\/|\*|\/\*)/.test(line);
      const slashed = /(>|\{["`])\/\/ ?(?=[A-Za-z{$])/.test(line) || /\{"\/\/ "\}/.test(line) || /["'`]\/\/ [A-Za-z$]/.test(line);
      if (rel.endsWith(".tsx") && !comment && !noted && slashed)
        mono.push({ at: `${root}/${rel}:${i + 1}`, what: 'a heading opened with "// "' });
    }
  }
}
if (mono.length) {
  console.error(`[lint:section-headings] ${mono.length} heading(s) or label(s) in the code font's clothes:\n`);
  for (const m of mono) console.error(`  ${m.at}  ${m.what}`);
  console.error(`
  The owner (#6337): "// TAGS", "// HISTORY" read as the code font in the UI.
  A section heading or label is uppercase + wide tracking in the app's face:

      <h3 className="text-[10px] uppercase tracking-widest text-accent">Tags</h3>

  Drop font-mono and the "// ". A real code shown uppercase (an error code, a
  hex) keeps font-mono with {/* mono: <what it is> */} on the line above.
`);
  process.exit(1);
}

if (bad.length) {
  console.error("[lint:section-headings] section heading from a foreign type family:\n");
  for (const b of bad) {
    console.error(`  web/src/${b.file}:${b.line}`);
    console.error(`      className="${b.cls}"`);
  }
  console.error(`
  A card title is text-sm font-semibold (SettingsSection's shape); a section
  rule is uppercase + wide tracking in the app's own face (never font-mono):

      <h3 className="text-[10px] uppercase tracking-widest text-accent">Tags</h3>

  Size may vary for a denser or more prominent section. The TYPE FAMILY may not:
  a proportional, muted, tracking-wide heading beside a mono one reads as
  something that wandered in from another app.

  For a bordered card with a title, use <SettingsSection> instead.
`);
  process.exit(1);
}

console.log("[lint:section-headings] ok — every uppercase section heading uses the app's family.");
