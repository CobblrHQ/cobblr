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

/** Every real heading in a markdown doc: a `#` line inside a fenced code
 *  block is a shell comment, not a heading. Reading one as a heading ended the
 *  Digital Fabrication section at "# upload a sliced file" in a curl example,
 *  and every blurb flushed there landed inside the code block, so six
 *  sections of the user guide rendered as code. */
function headingLines(text) {
  const out = [];
  let fence = null;
  text.split("\n").forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = line.match(HEADING_RE);
    if (m) out.push({ i, level: m[1].length, text: m[2].trim() });
  });
  return out;
}

/** Index of the line whose markdown heading TEXT equals `heading`
 *  (case-insensitive, level-agnostic — mirrors the flush's splice lookup),
 *  or -1 when no heading in `text` matches. */
export function findHeadingLine(text, heading) {
  const want = String(heading).trim().toLowerCase();
  if (!want) return -1;
  return headingLines(text).find((h) => h.text.toLowerCase() === want)?.i ?? -1;
}

/** Append `body` at the END of `heading`'s section (before the next real
 *  heading of the same or a higher level), with one blank line each side.
 *  THROWS when the heading is absent: never invents a stray "## <heading>" at
 *  end-of-file (audit H5). */
export function spliceAtSectionEnd(text, heading, body) {
  const heads = headingLines(text);
  const want = String(heading).trim().toLowerCase();
  const at = heads.findIndex((h) => h.text.toLowerCase() === want);
  if (!want || at < 0) throw new Error(`heading "${heading}" not found`);
  const lines = text.split("\n");
  const next = heads.slice(at + 1).find((h) => h.level <= heads[at].level);
  const end = next ? next.i : lines.length;
  const before = lines.slice(0, end).join("\n").replace(/\n+$/, "");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${body.trim()}\n${after ? "\n" + after : ""}`;
}

/** Headings a staged `## docs` body would bring that its target file already
 *  has. Publishing it would print a second copy: a blurb staged for "LightBurn
 *  job review" opened with its own "### LightBurn job review" while the guide
 *  already had that section written by hand. */
export function headingsAlreadyIn(fileText, docsBody) {
  const have = new Set(headingLines(fileText).map((h) => h.text.toLowerCase()));
  return headingLines(docsBody)
    .map((h) => h.text)
    .filter((t) => have.has(t.toLowerCase()));
}

/** Paragraphs of a staged `## docs` body its target file already carries,
 *  compared with whitespace collapsed. An author who writes the guide text by
 *  hand and leaves the blurb staged gets it printed twice by the flush: the
 *  robot-arm entry (#6943) shipped its three paragraphs in USER_GUIDE.md and in
 *  its changelog body at once. Short lines are skipped; they repeat by chance. */
export function paragraphsAlreadyIn(fileText, docsBody) {
  const flat = (t) => t.replace(/\s+/g, " ").trim();
  const have = flat(fileText);
  return String(docsBody)
    .split(/\n\s*\n/)
    .map(flat)
    .filter((para) => para.length >= 60 && have.includes(para));
}

/** Every heading TEXT in a markdown doc, in order — for "did you mean" hints. */
export function listHeadings(text) {
  return headingLines(text).map((h) => h.text);
}
