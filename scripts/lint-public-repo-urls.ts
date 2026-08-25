// A GitHub URL that ships must point at the PUBLIC mirror, never the private repo.
//
// The bug this exists for: the self-hosted bug-report button shipped pointing at
// github.com/CobblrHQ/core — the private repo, which 404s for everyone outside
// the org. The feature's entire purpose was giving self-hosters a route to the
// project, and its one link was a dead end. The unit test locked the mistake in,
// asserting the wrong URL under the test name "points at the public repo".
//
// The public repo's name already lives in ONE authoritative place:
// scripts/publish/manifests/core.json `target`. So shipping code never gets to
// spell a repo name freehand — any github.com/CobblrHQ/<x> in the shipping
// trees must name that target (or a repo explicitly allowed below).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(join(ROOT, "scripts/publish/manifests/core.json"), "utf8"),
) as { target: string };
const TARGET = manifest.target; // e.g. "CobblrHQ/cobblr"

/** Other org repos that are genuinely public and fine to reference. Add with a
 *  reason; the default is that shipping code names only the mirror. */
const ALLOWED: Record<string, string> = {
  // A provenance comment in the vendored copy, telling a MAINTAINER where the
  // canonical source lives — not a link shown to users. The repo is private,
  // and saying so truthfully beats scrubbing where the code came from.
  "CobblrHQ/bricklink-connector": "vendored-module provenance comment",
};

/** The trees that ship (mirror + built artifacts). scripts/ and docs/ stay
 *  internal-only per the publish allowlist and may name whatever they like. */
const SHIPPING = ["web/src", "api/src", "modules", "packages", "deploy"];

let out = "";
try {
  out = execFileSync(
    "grep",
    ["-rn", "-o", "-E", "github\\.com/CobblrHQ/[A-Za-z0-9._-]+", ...SHIPPING],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch (e) {
  const err = e as { status?: number; stdout?: string };
  if (err.status === 1) out = ""; // no matches
  else out = err.stdout ?? "";
}

const bad: string[] = [];
for (const line of out.split("\n")) {
  if (!line) continue;
  const m = line.match(/^(.*?):(\d+):github\.com\/CobblrHQ\/([A-Za-z0-9._-]+)/);
  if (!m) continue;
  // Trailing dot = the sentence's period, not part of the name.
  const repo = `CobblrHQ/${m[3]!.replace(/\.git$/, "").replace(/\.$/, "")}`;
  if (repo === TARGET || repo in ALLOWED) continue;
  bad.push(`  ✗ ${m[1]}:${m[2]}  →  ${repo}`);
}

if (bad.length) {
  console.error(`[lint:public-repo-urls] shipping code names a repo that is not the public mirror (${TARGET}):\n`);
  for (const b of bad) console.error(b);
  console.error(`
  Anything under ${SHIPPING.join(", ")} reaches self-hosters, and a link to a
  private repo 404s for every one of them. Use ${TARGET}, or add the repo to
  ALLOWED in this file with a reason if it really is public.
`);
  process.exit(1);
}
console.log(`[lint:public-repo-urls] ok — every shipped CobblrHQ URL names the public mirror (${TARGET}).`);
