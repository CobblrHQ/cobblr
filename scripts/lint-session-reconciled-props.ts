// A value reconciled ACROSS a session must be handed to every card that shows it.
//
// The scan inbox showed "Category Figurines" on some cards and "Category
// Figurine" on others, for nine items in one session (the author, 2026-08-02). Each
// card rendered its OWN raw value through `categoryDisplay`, which is per-item
// by construction and preserves a value that already carries capitals. It had
// no way to know a sibling said it differently, because reconciliation is
// inherently cross-item.
//
// The fix computes the session's agreed label once and passes it in. The way
// that fix rots is silent and cheap: someone adds a FOURTH <InboxCard> render
// site (there were three), forgets the prop, and that card quietly falls back
// to per-item display. Nothing errors, nothing looks broken in review, and the
// disparity is back for exactly the items nobody screenshotted.
//
// So: every InboxCard render site must pass the session-reconciled label. A prop
// that is required for CORRECTNESS but optional in the types is a trap; this is
// the check that closes it.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Requirement {
  /** The component whose render sites are checked. */
  component: string;
  /** Props every render site must pass. */
  required: string[];
  /** Files to scan. */
  files: string[];
  /** Why, shown when it fails. */
  because: string;
}

const REQUIREMENTS: Requirement[] = [
  {
    component: "InboxCard",
    required: ["sessionCategoryLabel"],
    files: ["web/src/pages/ScanPage.tsx"],
    because:
      "the category label is reconciled across the SESSION, so a card that is not told it " +
      "falls back to its own raw value and one session shows two spellings.",
  },
];

/** Blank comments so a mention in prose is not a render site. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, " "));
}

/**
 * The text of each JSX element opened for `component`, from `<Name` to the `>`
 * that closes the opening tag. Quote-aware and brace-aware so a `>` inside a
 * prop expression (`onClick={() => x}`) does not end the tag early.
 */
function openingTags(src: string, component: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = new RegExp(`<${component}(?![A-Za-z0-9_])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({
      line: src.slice(0, m.index).split("\n").length,
      text: src.slice(m.index, i),
    });
  }
  return out;
}

let failures = 0;
for (const { component, required, files, because } of REQUIREMENTS) {
  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`lint:session-reconciled-props — ${rel} no longer exists; update this lint.`);
      process.exit(1);
    }
    const src = stripComments(readFileSync(abs, "utf8"));
    const tags = openingTags(src, component);
    if (tags.length === 0) {
      console.error(
        `lint:session-reconciled-props — no <${component}> render sites found in ${rel}.\n` +
          `If it was renamed or moved, update this lint rather than losing the check.`,
      );
      process.exit(1);
    }
    for (const tag of tags) {
      for (const prop of required) {
        if (new RegExp(`\\b${prop}\\s*=`).test(tag.text)) continue;
        console.error(
          `${rel}:${tag.line}  <${component}> is missing the ${prop} prop\n` +
            `    ${because}`,
        );
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(
    `\nlint:session-reconciled-props — ${failures} render site(s) missing a cross-item value.\n` +
      `Pass the session-reconciled label; do not fall back to the per-item display helper.\n`,
  );
  process.exit(1);
}
console.log("lint:session-reconciled-props ✓ every card is told what its session agreed on.");
