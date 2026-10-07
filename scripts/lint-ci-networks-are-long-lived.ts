#!/usr/bin/env tsx
// A CI workflow or script never creates or removes a Docker network per run: it joins a long-lived one (cobblr-ci-boot), because every network made or dropped on a runner host disturbs every tailnet connection on it.
//
// THE BUG THIS PREVENTS. 2026-10-07: scripts/ci/boot-every-module.sh made and removed a network on every image
// check. Each one adds or drops a bridge address on the runner host: tailscaled logs "LinkChange: major,
// rebinding" (every tailnet connection on the A6: registry pulls, the forge, staging), and Chromium on host
// networking aborts every request in flight, which filed three fundamentals areas red (#5140-#5142).
// Measured on the A6: a network made and removed, 2 rebinds; a container started on an existing one, none.
//
// THE RULE. In .forgejo/workflows and scripts/ci, `docker network create` names the shared network (its
// literal, or $NET / ${BOOT_NETWORK...}) and `docker network rm` does not appear at all. A one-off that must
// make its own says why on the line: `# network-churn-ok: <why>`.
//
// THE BOUNDARY. What CI runs on its runners. A box's own long-lived stacks (compose files in docker/, the dev
// rig) make their networks once, at deploy, and are not churn.
//
//   npx tsx scripts/lint-ci-networks-are-long-lived.ts   (pnpm lint ci-networks-are-long-lived)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.js";

const SHARED = /cobblr-ci-boot|\$NET\b|\$\{NET\}|\$\{BOOT_NETWORK/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*(#|\/\/)/.test(line) || /network-churn-ok: \S/.test(line)) return;
    if (/docker network (rm|remove|prune)\b/.test(line)) out.push({ file, line: i + 1, what: "removes a Docker network: the shared one stays, and a per-run one is churn on the host" });
    else if (/docker network create\b/.test(line) && !SHARED.test(line)) out.push({ file, line: i + 1, what: "creates a Docker network per run: join cobblr-ci-boot instead" });
  });
  return out;
}

const files = repoFiles().filter((f) => (f.startsWith(".forgejo/workflows/") && /\.ya?ml$/.test(f)) || (f.startsWith("scripts/ci/") && /\.(sh|mjs|js|ts)$/.test(f) && !/\.test\./.test(f)));
const violations: Violation[] = [];
for (const file of files) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:ci-networks-are-long-lived - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("join cobblr-ci-boot (create it only if missing, never remove it), or # network-churn-ok: <why>");
  process.exit(1);
}
console.log(`lint:ci-networks-are-long-lived OK (${files.length} files)`);
