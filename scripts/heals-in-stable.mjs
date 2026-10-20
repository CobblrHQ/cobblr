#!/usr/bin/env node
// The heals the latest stable release shipped with, as scripts/heals-in-stable.json.
//
//   node scripts/heals-in-stable.mjs --write [<tag>]   # regenerate from the tag (default: the latest stable tag)
//   node scripts/heals-in-stable.mjs --check           # exit 1 when the file is not what the tag holds
//
// Cut a release, run --write, commit: lint:heal-shims holds a heal's deletion to this
// list (scripts/lib/heal-retirement.mjs). A stable install ran every heal in it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isHealPath, isHealSource } from "./lib/heal-retirement.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FILE = join(ROOT, "scripts", "heals-in-stable.json");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 });

/** The newest CalVer tag in this clone, or null when the clone has none (a shallow CI checkout). */
export function latestStableTag() {
  const tags = git("tag", "-l", "20[0-9][0-9].*.*").split("\n").filter((t) => /^\d{4}\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return tags.at(-1) ?? null;
}

/** Every heal file in the tree at `tag`. */
export function healsAt(tag) {
  const named = git("grep", "-l", "DONE WHEN:", tag, "--", "api/src", "modules").split("\n").filter(Boolean)
    .map((l) => l.slice(tag.length + 1)).filter(isHealPath);
  return named.filter((p) => isHealSource(git("show", `${tag}:${p}`))).sort();
}

export function read() {
  return JSON.parse(readFileSync(FILE, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, tagArg] = process.argv.slice(2);
  const tag = tagArg ?? (mode === "--check" ? read().tag : latestStableTag());
  if (!tag) { console.error("heals-in-stable: no stable tag in this clone"); process.exit(2); }
  const heals = healsAt(tag);
  if (mode === "--write") {
    writeFileSync(FILE, JSON.stringify({ tag, heals }, null, 2) + "\n");
    console.log(`heals-in-stable: ${heals.length} heal(s) in ${tag}`);
  } else if (mode === "--check") {
    const have = read();
    if (JSON.stringify(have.heals) !== JSON.stringify(heals)) { console.error(`heals-in-stable: ${FILE} is not what ${tag} holds; run --write ${tag}`); process.exit(1); }
    console.log(`heals-in-stable: matches ${tag}`);
  } else { console.error("usage: heals-in-stable.mjs --write [<tag>] | --check"); process.exit(2); }
}
