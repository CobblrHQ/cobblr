// A script run from a git hook never writes into core when it means another repo.
//
// A git hook runs with GIT_DIR (and GIT_INDEX_FILE, GIT_WORK_TREE and the rest
// of `git rev-parse --local-env-vars`) set for the repository it fired in, and
// `git -C <other repo>` obeys GIT_DIR over -C. So under the pre-push hook a lint
// reading seventeen client repositories read this one seventeen times (#3545),
// and a test that builds a fixture repository, commits and pushes would have
// committed and pushed into core. These are the variables that point git at a
// repository; clearing them makes every git call find its repository from its
// own directory again.
//
// Cleared at the two places the hook's environment reaches a script: the top of
// scripts/git-hooks/pre-push (everything it runs inherits a clean environment
// and still finds core from its cwd) and scripts/lib/vitest-setup.mjs (every
// test). pre-commit and commit-msg keep theirs: the one script they run reads
// the staged index, which a commit of named paths points at through
// GIT_INDEX_FILE. lint:hook-git-env holds both call sites, and refuses a second
// hand-kept copy of the list.

/** `git rev-parse --local-env-vars` (git 2.54), plus the receive-side quarantine. */
export const REPO_LOCATING_VARS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_QUARANTINE_PATH",
]);

/** @param {string} name */
export function isRepoLocating(name) {
  return REPO_LOCATING_VARS.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name);
}

/** A copy of `env` a git call aimed at another repository can safely use. */
export function envForOtherRepo(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !isRepoLocating(k)));
}

/** Remove them from `env` in place; returns the names removed. */
export function clearRepoLocating(env = process.env) {
  const removed = Object.keys(env).filter(isRepoLocating);
  for (const k of removed) delete env[k];
  return removed;
}
