// Find forbidden terms in text and in paths. The terms are regular expressions, matched case-sensitively,
// one line at a time. Pure: what to scan and which terms are the caller's.

/** @param {string[]} terms @returns {[string, RegExp][]} */
export const compileTerms = (terms) => terms.map((t) => [t, new RegExp(t, "g")]);

/** Every line of `text` a term matches. @param {string} text @param {[string, RegExp][]} compiled */
export function scanText(text, compiled) {
  /** @type {{ line: number, term: string }[]} */
  const hits = [];
  String(text).split("\n").forEach((line, i) => {
    for (const [term, re] of compiled) {
      re.lastIndex = 0;
      if (re.test(line)) hits.push({ line: i + 1, term });
    }
  });
  return hits;
}

/** The terms a path contains: a leak can hide in a file's name. @param {string} path @param {[string, RegExp][]} compiled */
export const scanPath = (path, compiled) => compiled.filter(([, re]) => ((re.lastIndex = 0), re.test(path))).map(([term]) => term);
