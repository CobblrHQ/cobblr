#!/usr/bin/env sh
# Clear the variables a git hook sets to point git at ITS repository, so every
# git call a script makes finds its repository from its own directory. See
# scripts/lib/git-env.mjs for why; this is the shell twin, and git's own list.
# cwd-repo: `git rev-parse --local-env-vars` prints a fixed list and reads no repository.
clear_hook_git_env() {
  for _v in $(git rev-parse --local-env-vars 2>/dev/null) GIT_QUARANTINE_PATH; do
    unset "$_v"
  done
  for _v in $(env | sed -n 's/^\(GIT_CONFIG_\(KEY\|VALUE\)_[0-9][0-9]*\)=.*/\1/p'); do
    unset "$_v"
  done
  unset _v
}
