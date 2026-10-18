// The user guide is one page per area (docs/user-guide/<area>.md) behind an
// index (docs/USER_GUIDE.md). One file used to hold all of it, and every feature
// pull request appended to it, so any two collided in the merge queue (#7321).
// Everything that reads or writes the guide goes through here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GUIDE_INDEX = "docs/USER_GUIDE.md";
export const GUIDE_DIR = "docs/user-guide";
export const AREAS_FILE = `${GUIDE_DIR}/areas.json`;

const at = (root, p) => (root ? join(root, p) : p);

/** { <area>: { title, about, scopes } }, read from areas.json. */
export function areas(root = "") {
  // A checkout without the guide (the public export ships this helper beside
  // docs-target.mjs) has no areas: nothing to route, nothing to follow.
  if (!existsSync(at(root, AREAS_FILE))) return {};
  return JSON.parse(readFileSync(at(root, AREAS_FILE), "utf8")).files;
}

/** Every area page, as a repo-relative path, in areas.json order. */
export function areaFiles(root = "") {
  if (!existsSync(at(root, GUIDE_DIR))) return [];
  const known = Object.keys(areas(root)).map((a) => `${GUIDE_DIR}/${a}.md`);
  const onDisk = readdirSync(at(root, GUIDE_DIR)).filter((f) => f.endsWith(".md")).map((f) => `${GUIDE_DIR}/${f}`);
  return [...known.filter((f) => onDisk.includes(f)), ...onDisk.filter((f) => !known.includes(f))];
}

/** The whole guide as one text: the index, then every area page. */
export function readWholeGuide(root = "") {
  return [GUIDE_INDEX, ...areaFiles(root)].filter((f) => existsSync(at(root, f))).map((f) => readFileSync(at(root, f), "utf8")).join("\n\n");
}

/** The area page a changelog scope's docs belong on, or null when no area claims it. */
export function areaForScope(scope, root = "") {
  if (!scope) return null;
  const s = String(scope).trim().toLowerCase();
  for (const [a, meta] of Object.entries(areas(root))) {
    if ((meta.scopes ?? []).some((x) => x.toLowerCase() === s)) return `${GUIDE_DIR}/${a}.md`;
  }
  return null;
}

/** A heading on the index is a moved-section stub: "Moved to [..](user-guide/<area>.md#anchor)."
 *  Returns the area page the stub points at, or null when the heading is not a stub. */
export function stubTarget(heading, root = "") {
  const path = at(root, GUIDE_INDEX);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  const want = String(heading).trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.*?)\s*$/);
    if (!m || m[1].trim().toLowerCase() !== want) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const link = lines[j].match(/^Moved to \[[^\]]*\]\((user-guide\/[^)#]+\.md)/);
      if (link) return `docs/${link[1]}`;
      if (/^#{1,6}\s/.test(lines[j])) break;
    }
  }
  return null;
}

/** Which area page holds a heading, searching every page (level-agnostic, case-insensitive). */
export function areaHolding(heading, root = "") {
  const want = String(heading).trim().toLowerCase();
  for (const f of areaFiles(root)) {
    const text = readFileSync(at(root, f), "utf8");
    if (text.split("\n").some((l) => { const m = l.match(/^#{1,6}\s+(.*?)\s*$/); return m && m[1].trim().toLowerCase() === want; })) return f;
  }
  return null;
}
