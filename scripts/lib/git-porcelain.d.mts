// Types for git-porcelain.mjs. The implementation stays plain ESM so node can
// run it from a publish script; these declarations let lints and the vitest
// suite import it under `strict`.

export interface PorcelainEntry {
  /** The two status columns as git prints them (" M", "??", "A ", "R ", ...). */
  status: string;
  /** The path as it exists now (the `new` side of a rename). */
  path: string;
}

/** Each entry of a porcelain block. Tolerates a trimmed block. */
export declare function parsePorcelain(raw: string): PorcelainEntry[];

/** Runs `git status --porcelain` in `cwd` (default: the process cwd) and parses it. */
export declare function workingTreeStatus(cwd?: string): PorcelainEntry[];

/** Just the paths that differ from HEAD, tracked or not. */
export declare function workingTreePaths(cwd?: string): string[];
