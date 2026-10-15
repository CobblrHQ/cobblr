// Path globs for a repository's config: `**` any depth, `*` within one segment, `?` one character.

/** @param {string} glob */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** @param {string[]} globs @returns {(path: string) => boolean} */
export function matcher(globs) {
  const res = globs.map(globRe);
  return (path) => res.some((r) => r.test(path));
}
