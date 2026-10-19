// The tracked text tree's size, MB: what a lint that reads the source grows with (lib/lint-budget.mjs scales
// each read budget by it). Text only: an image or a vendored binary no lint reads would move it for nothing.
import { execFileSync } from "node:child_process";

export const TEXT = /\.(ts|tsx|mts|mjs|js|cjs|json|md|yml|yaml|css|sql|sh|py|html|svg)$/;

/** PURE. The text tree's MB from `git ls-tree -r -l` output. */
export function textTreeMB(lsTree) {
  let bytes = 0;
  for (const line of String(lsTree).split("\n")) {
    const m = /^\S+ blob \S+\s+(\d+)\t(.+)$/.exec(line);
    if (m && TEXT.test(m[2])) bytes += Number(m[1]);
  }
  return Math.round((bytes / 1048576) * 10) / 10;
}

/** The text tree at `rev`, MB, or null when git cannot say. */
export function treeTextMB(rev = "HEAD", cwd = process.cwd()) {
  try {
    return textTreeMB(execFileSync("git", ["ls-tree", "-r", "-l", rev], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}
