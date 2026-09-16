// secretFile(name) — where a credential file lives, checking the new home first.
//
// Credential files used to be loose dotfiles in $HOME, which grew to 30+ and made
// them impossible to pick out. They now live in ~/.secrets/<name> (no leading dot,
// dir 700, file 600). This resolves BOTH: the new path, then the legacy ~/.<name>,
// so a file can be moved whenever without a matching code change. $COBBLR_SECRETS_DIR
// overrides the directory (the boxes use the same layout under their own $HOME).
//
// Returns the first READABLE path, else the preferred one — a caller that wants to
// print "no credential at X" then names where the file should go, rather than the
// legacy path nobody should be creating anymore.
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function secretDir() {
  return process.env.COBBLR_SECRETS_DIR || join(homedir(), ".secrets");
}

export function secretFile(name) {
  const bare = name.replace(/^\./, "");
  const candidates = [join(secretDir(), bare), join(homedir(), `.${bare}`)];
  for (const p of candidates) {
    try {
      accessSync(p, constants.R_OK);
      return p;
    } catch {
      /* try the next one */
    }
  }
  return candidates[0];
}

// The first line that is neither blank nor a comment. A credential file is a file a
// human edits, so it grows a header explaining what the token is for and where to
// regenerate it; the value is not necessarily line 1. Same rule as forgejo_token(),
// which exists because a raw `cat` of such a file yields a multi-line value and
// libcurl rejects a header containing a newline.
//
// Returns "" when the file is missing or holds only comments. Callers decide whether
// that is fatal: a webhook being unset is normal and silent, a token being unset is
// usually an error.
export function readSecret(name) {
  try {
    return (
      readFileSync(secretFile(name), "utf8")
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trim())
        .find((l) => l && !l.startsWith("#")) ?? ""
    );
  } catch {
    return "";
  }
}
