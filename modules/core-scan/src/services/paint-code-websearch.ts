// Vehicle paint-code resolution, Tier 2: web-search the code (free, no tokens).
// See docs/design-decisions/vehicle-color-resolution.md.
//
// The fallback for a code not in the curated Tier-1 table. Same shape as the
// barcode web-search fallback (services/barcode-websearch.ts): DDG-search the
// code, then a PURE heuristic pulls the marketing color name out of the result
// TITLES — no LLM. A touch-up-paint listing's title almost always reads
// "<Make> <CODE> <Color Name> Touch Up Paint" (or "<CODE> - <Color Name>"), so
// the color sits right next to the code.
//
// Split like the barcode path: `extractColorFromTitles` is PURE + unit-tested;
// `resolvePaintCodeViaWeb` is the thin network orchestrator (dormant until the
// resolver is wired into the scan pipeline — a benchmark-gated step).

import { searchText } from "./ddg-images.js";
import { normalizePaintCode } from "./paint-code-table.js";

// A color/finish word — a marketing paint name essentially always contains one
// ("Lunar Silver Metallic", "Blizzard Pearl", "Rallye Red", "Super White"). Used
// to VALIDATE a candidate phrase so we don't return a make/model/noise fragment.
const FAMILY = new Set(
  (
    "white black silver gray grey red blue green gold bronze beige brown orange yellow purple " +
    "maroon burgundy navy teal turquoise copper champagne cream ivory charcoal graphite steel " +
    "titanium platinum obsidian slate granite pewter gunmetal sand pearl mica metallic pearlcoat " +
    "tricoat tintcoat clearcoat crystal diamond effect"
  ).split(" "),
);

// Listing noise that surrounds the color — trimmed off a candidate chunk.
const NOISE = new Set(
  (
    "touch up touchup paint pen spray aerosol oem genuine automotive basecoat clearcoat base clear " +
    "coat kit bottle brush scratch repair color colour code for the by and exact match auto car " +
    "vehicle 2in1 quart oz ml roller"
  ).split(" "),
);

/** A regex that matches the code in a title tolerating the spaces/hyphens a
 *  label or listing sprinkles in ("NH830M" ↔ "NH-830M" ↔ "NH 830 M"). */
function codeRegex(code: string): RegExp {
  const flexible = normalizePaintCode(code)
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s-]?");
  return new RegExp(flexible, "i");
}

/** Clean + validate one candidate chunk (the text on one side of the code, up to
 *  the nearest delimiter). Drops the make + listing noise, caps length, and
 *  requires a color/finish word + Title-Case. Returns the tidy name or null. */
function cleanCandidate(chunk: string, make: string): string | null {
  const makeLc = make.trim().toLowerCase();
  const words = chunk
    .replace(/\(.*?\)/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")) // strip surrounding punctuation
    .filter((w) => {
      if (!w) return false;
      const lc = w.toLowerCase();
      if (lc === makeLc || NOISE.has(lc)) return false;
      if (/^\d{2,4}$/.test(w)) return false; // years / sizes
      return true;
    });
  if (words.length === 0 || words.length > 5) return null;
  // Color names are Title-Cased; reject a run of lowercase prose words.
  if (!words.every((w) => /^[A-Z]/.test(w))) return null;
  if (!words.some((w) => FAMILY.has(w.toLowerCase()))) return null;
  return words.join(" ");
}

/**
 * PURE: pull the marketing color name out of web-search result TITLES for a paint
 * code. For each title, split off the chunk adjacent to the code on each side
 * (delimiters `- | / , ( )` etc.), clean + validate it, then VOTE across titles
 * (most recurring wins; ties → longest). Returns null when no title yields a
 * confident color — the caller then leaves the field blank (never guesses).
 */
export function extractColorFromTitles(
  titles: string[],
  code: string,
  make: string,
): string | null {
  const re = codeRegex(code);
  const DELIM = /\s[-–—|/•]\s|[|/()[\],]/;
  const votes = new Map<string, { name: string; n: number }>();
  const add = (name: string | null) => {
    if (!name) return;
    const key = name.toLowerCase();
    const cur = votes.get(key);
    if (cur) cur.n += 1;
    else votes.set(key, { name, n: 1 });
  };
  for (const title of titles) {
    const m = re.exec(title);
    if (!m) continue;
    const before = title.slice(0, m.index);
    const after = title.slice(m.index + m[0].length);
    // The chunk NEAREST the code on each side (last-before / first-after).
    const beforeChunk = before.split(DELIM).filter((s) => s.trim()).pop() ?? "";
    const afterChunk = after.split(DELIM).map((s) => s.trim()).find((s) => s) ?? "";
    add(cleanCandidate(afterChunk, make));
    add(cleanCandidate(beforeChunk, make));
  }
  if (votes.size === 0) return null;
  return [...votes.values()].sort((a, b) => b.n - a.n || b.name.length - a.name.length)[0]!.name;
}

export interface PaintWebResolution {
  name: string;
  source: "paint-web-search";
}

/**
 * Tier 2 orchestrator (NETWORK — impure, thin). DDG-search the code and run the
 * pure extractor over the titles. DORMANT: nothing calls this yet — the scan-
 * pipeline wiring (which would try Tier 1, then this on a table miss, and cache
 * the hit) is a separate, benchmark-gated step. Degrades to null on any search
 * failure — never throws, never guesses.
 */
export async function resolvePaintCodeViaWeb(
  make: string,
  code: string,
): Promise<PaintWebResolution | null> {
  const q = `${make} ${normalizePaintCode(code)} paint code color name`;
  const results = await searchText(q, 10).catch(() => []);
  const name = extractColorFromTitles(
    results.map((r) => r.title),
    code,
    make,
  );
  return name ? { name, source: "paint-web-search" } : null;
}
