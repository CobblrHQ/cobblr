#!/usr/bin/env tsx
// A script that reads git output growing with the repository (a whole log, rev-list, ls-files, ls-tree or grep) gives execFileSync a maxBuffer, because Node's 1 MB default is passed as the repository grows and git is killed mid-read.
//
// THE BUG THIS PREVENTS. 2026-10-14: the public mirror stopped publishing when main's merge log passed 2 MB (ENOBUFS, run 48996)
//
// THE RULE. An execFileSync/spawnSync of git under scripts/ whose output grows with the repository passes
// `maxBuffer` in its options: `log` or `rev-list` without a count (-n, -1, --max-count), and `ls-files`,
// `ls-tree` or `grep`. One that is bounded another way says so on the call's line or the line above:
// `// GIT-OUTPUT-BOUNDED: <why>`.
//
// THE BOUNDARY. A call whose arguments are built elsewhere (`...args`) cannot be judged here and is not; the
// helper that runs it is where its buffer goes (build-public-history's `git()`). Tests are not judged: their
// fixture repositories are small by construction. `stdio: "ignore"` keeps no output and needs no buffer.
//
// PROVE IT RED: on main before this change it names eleven lints' whole-repository `git grep` and
// lint-compose-unique-keys's `ls-files`.
//
//   npx tsx scripts/lint-repo-sized-git-reads-have-room.ts   (pnpm lint repo-sized-git-reads-have-room)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repoFiles } from "./lib/repo-files.ts";

export interface Hit {
  line: number;
  sub: string;
}

/** PURE. The git calls in one source whose output grows with the repository and that set no maxBuffer. */
export function findUnbounded(src: string): Hit[] {
  const out: Hit[] = [];
  const lines = src.split("\n");
  for (const m of src.matchAll(/(execFileSync|spawnSync)\(\s*["']git["']\s*,/g)) {
    // The whole call, to its matching parenthesis: an argument can hold brackets ("[[:space:]]").
    let depth = 0;
    let end = m.index!;
    let quote = "";
    for (let k = m.index! + m[1]!.length; k < src.length; k++) {
      const ch = src[k]!;
      if (quote) {
        if (ch === "\\") k++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) {
        end = k;
        break;
      }
    }
    const call = src.slice(m.index!, end + 1);
    if (/maxBuffer/.test(call) || /stdio:\s*["']ignore["']/.test(call)) continue;
    const words = [...call.slice(call.indexOf("[")).matchAll(/["']([a-z][a-z-]*)["']/g)].map((w) => w[1]!);
    const sub = words[0] ?? "";
    const counted = /["'](-n|-1|--max-count(=\d+)?|-\d+)["']/.test(call);
    const grows = ((sub === "log" || sub === "rev-list") && !counted) || sub === "ls-files" || sub === "ls-tree" || sub === "grep";
    if (!grows) continue;
    const line = src.slice(0, m.index!).split("\n").length;
    if (/^\s*(\/\/|\*)/.test(lines[line - 1] ?? "")) continue; // a call quoted in a comment
    const near = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
    if (/\/\/\s*GIT-OUTPUT-BOUNDED:\s*\S/.test(near)) continue;
    out.push({ line, sub });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = repoFiles(["scripts"]).filter((f) => /\.(m?js|ts)$/.test(f) && !/\.test\.|\.d\.m?ts$/.test(f));
  const violations: string[] = [];
  for (const f of files) {
    let src = "";
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const h of findUnbounded(src)) violations.push(`  ${f}:${h.line}  git ${h.sub} reads output that grows with the repository and sets no maxBuffer`);
  }
  if (violations.length) {
    console.error(`lint:repo-sized-git-reads-have-room - ${violations.length} call(s):`);
    for (const v of violations) console.error(v);
    console.error("Pass maxBuffer (1024 * 1024 * 1024) in its options, or say why it is bounded: // GIT-OUTPUT-BOUNDED: <why>");
    process.exit(1);
  }
  console.log("lint:repo-sized-git-reads-have-room OK");
}
