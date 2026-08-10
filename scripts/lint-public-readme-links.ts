// Guard: the public README may only link to files that actually ship.
//
// The public repo is an ALLOWLIST export. `docs/`, `CLAUDE.md`, most of
// `scripts/` and every internal runbook are held back, so a link that reads as
// perfectly fine here becomes a 404 for the first stranger who clicks it. The
// internal README links three such paths quite legitimately, which is how easy
// the mistake is to copy across; and it is only ever wrong in the exported tree,
// which nobody rebuilds locally to look at.
//
// Same check for the reverse mistake: a link to a file that does not exist at
// all, which is just as dead and much easier to introduce.
//
// Only the overlay is checked. `README.md` at the repo root is internal and is
// SUPPOSED to link to CLAUDE.md and docs/, so holding it to this rule would be
// wrong.
//
// Run: npx tsx scripts/lint-public-readme-links.ts

import { readFileSync, existsSync, globSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, relative, posix } from "node:path";
import { shippedPaths } from "./publish/path-gate.mjs";

const MANIFEST = "scripts/publish/manifests/core.json";

// This lint ships publicly (scripts/lint-*.ts is on the allowlist) but the
// manifest it reads does not, so in the exported tree there is nothing to check.
// Skip rather than fail: a lint that cannot run is not a violation.
if (!existsSync(MANIFEST)) {
  console.log("public-readme-links lint: skipped (no publish manifest in this tree)");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const overlayDir = resolve(dirname(MANIFEST), manifest.overlay);
if (!existsSync(overlayDir)) {
  console.error(`public-readme-links lint: overlay dir not found: ${overlayDir}`);
  process.exit(1);
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const shipped = new Set(shippedPaths(tracked, manifest));
if (shipped.size === 0) {
  console.error("public-readme-links lint: manifest matched no tracked files — the check would pass vacuously.");
  process.exit(1);
}
// Overlay files land at the root of the export and win over anything staged.
const overlayFiles = globSync("*", { cwd: overlayDir });
for (const f of overlayFiles) shipped.add(f);

/** Does this link target resolve to something in the published tree? */
const shipsTarget = (target: string) => {
  if (shipped.has(target)) return true;
  // A directory link is fine when anything under it ships.
  const asDir = target.endsWith("/") ? target : `${target}/`;
  for (const p of shipped) if (p.startsWith(asDir)) return true;
  return false;
};

const MD_LINK = /\[[^\]]*\]\(\s*([^)\s]+)/g;

const offenders: Array<{ file: string; line: number; target: string; why: string }> = [];
for (const name of overlayFiles) {
  if (!name.endsWith(".md")) continue;
  const lines = readFileSync(resolve(overlayDir, name), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MD_LINK)) {
      const raw = m[1]!;
      if (/^(https?:|mailto:|#)/.test(raw)) continue;
      const target = posix.normalize(raw.split("#")[0]!.replace(/^\.\//, ""));
      if (!target || target === ".") continue;
      if (!existsSync(target) && !overlayFiles.includes(target)) {
        offenders.push({ file: name, line: i + 1, target, why: "does not exist" });
      } else if (!shipsTarget(target)) {
        offenders.push({ file: name, line: i + 1, target, why: "is not published (manifest holds it back)" });
      }
    }
  });
}

if (offenders.length > 0) {
  console.error(
    `\npublic-readme-links lint: ${offenders.length} link(s) in the public overlay would be dead:\n`,
  );
  const overlayRel = relative(process.cwd(), overlayDir);
  for (const o of offenders) console.error(`  ${overlayRel}/${o.file}:${o.line}  ${o.target}  — ${o.why}`);
  console.error(`\nLink to something the export ships, or point at the docs site instead.\n`);
  process.exit(1);
}

console.log(`public-readme-links lint: ok (${overlayFiles.filter((f) => f.endsWith(".md")).length} overlay doc(s) checked)`);
