// Canonical prose-style rules for USER-FACING writing: changelog entries, the
// staged docs blurbs they carry (## docs, spliced into the public docs at
// release), and the docs site (whose private lint imports this table).
// ONE place on purpose; edit here, everywhere follows.
//
// The voice: a person explaining their own product plainly. Direct, concrete,
// never performing. These rules catch the mechanical tells; the judgment calls
// (tricolons everywhere, heavy bolding, recap paragraphs) live with the
// reviewer.
//
// Escape hatch for a genuine false positive (for example a quoted UI string):
// end the line with <!-- prose-ok -->.
export const PROSE_RULES = [
  { id: "em-dash", re: /—/, why: "no em dashes; use a period, comma, colon, or parens" },
  { id: "candor", re: /honest (catch|truth)|honestly,|frankly|to be (clear|fair|honest)|let's be real|\bgenuinely\b/i, why: "candor-performance; state the fact plainly" },
  { id: "signpost", re: /worth (noting|getting right|mentioning)|a quick way to tell|here's the (payoff|thing)|the key (thing|point) is|it's important to/i, why: "signposting; just say the thing" },
  { id: "reframe", re: /isn't just a|not just a|more than (just )?a\b/i, why: "rhetorical reframe; state what it is ('rather than' works for a real contrast)" },
  { id: "ai-words", re: /\bdelve\b|\bseamless(ly)?\b|\bleverage\b|\bempower\b|\belevate your\b|\bsupercharge\b/i, why: "AI-marketing vocabulary" },
];

/** Lint a text; returns [{line, id, why, excerpt}] (1-indexed lines). */
export function lintProse(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("<!-- prose-ok -->")) return;
    for (const r of PROSE_RULES) {
      if (r.re.test(line)) hits.push({ line: i + 1, id: r.id, why: r.why, excerpt: line.trim().slice(0, 90) });
    }
  });
  return hits;
}
