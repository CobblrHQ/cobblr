// Shared parse + lookup for a changelog entry's docs_target ("<path.md>#<Heading>").
//
// Both the release-time flush (scripts/docs-flush.mjs) and the authoring-time gate
// (scripts/lint-changelog.ts) MUST agree on what "the heading exists" means, or the
// lint passes an entry that the flush then mis-files. When the heading was missing
// the flush used to APPEND a fresh "## <heading>" at end-of-file — six orphan
// sections piled up in USER_GUIDE.md that way (audit H5). One source of truth for
// the parse and the lookup keeps the two from drifting.

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/** Split "<path.md>#<Heading text>" → { file, heading }. No "#" → the whole
 *  string is the file and heading is "". Only the FIRST "#" splits (heading text
 *  may itself contain "#"). */
export function parseDocsTarget(target) {
  const t = String(target).trim();
  const hash = t.indexOf("#");
  const file = hash > 0 ? t.slice(0, hash) : t;
  const heading = hash > 0 ? t.slice(hash + 1).trim() : "";
  return { file, heading };
}

/** Index of the line whose markdown heading TEXT equals `heading`
 *  (case-insensitive, level-agnostic — mirrors the flush's splice lookup),
 *  or -1 when no heading in `text` matches. */
export function findHeadingLine(text, heading) {
  const want = String(heading).trim().toLowerCase();
  if (!want) return -1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[2].trim().toLowerCase() === want) return i;
  }
  return -1;
}

/** Every heading TEXT in a markdown doc, in order — for "did you mean" hints. */
export function listHeadings(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(HEADING_RE);
    if (m) out.push(m[2].trim());
  }
  return out;
}
