// A forbidden identifier can hide in a file's NAME, not just its body — a compat
// bundle whose filename carries the name of the product it is compatible with, say.
// The sanitize pass only
// rewrites file BODIES, so without a path scan a poisoned path ships silently
// (this bit the historical-snapshot export, where an old tree still carried the
// pre-rename filename). Kept pure and separate from export-repo.mjs so the
// matching logic can be unit-tested without executing the export script.
//
// Paths are deliberately NOT auto-rewritten: a silent rename can break imports
// or references that a body scan would never see. A hit is a hard FAIL — resolve
// it in the source by renaming or `exclude`-ing the file.
// Glob matching for the manifest's include/exclude lists (supports **, *, ?,
// literals; / is the path separator). It lives here rather than in
// export-repo.mjs because more than one caller now has to answer "does this
// path ship?", and two copies of that answer is one too many: a link checker
// that disagrees with the exporter is worse than no link checker.
export function globToRe(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

export const compileGlobs = (arr) => (arr || []).map(globToRe);
export const anyGlobMatch = (res, p) => res.some((r) => r.test(p));

/** The tracked paths a manifest would actually publish. */
export function shippedPaths(tracked, manifest) {
  const include = compileGlobs(manifest.include);
  const exclude = compileGlobs(manifest.exclude);
  return tracked.filter((p) => anyGlobMatch(include, p) && !anyGlobMatch(exclude, p));
}

export function forbiddenPathHits(files, forbidden) {
  const res = (forbidden || []).map((f) => [f, new RegExp(f, "g")]);
  const hits = [];
  for (const rel of files) {
    for (const [term, re] of res) {
      re.lastIndex = 0;
      if (re.test(rel)) hits.push({ file: rel, term });
    }
  }
  return hits;
}
