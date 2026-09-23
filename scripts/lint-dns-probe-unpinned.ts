#!/usr/bin/env tsx
// The CI box's DNS self-heal probes a tailnet host that is not pinned in
// /etc/hosts, or it can never fire.
//
// THE BUG THIS PREVENTS. scripts/ci-runner-health.sh heals a lost MagicDNS
// by toggling tailscale accept-dns when a tailnet name stops resolving. The
// name it probed was the git host, and a later section of the same script
// pinned that host in /etc/hosts so checkout would survive DNS loss. From
// that day the probe answered from the pin, MagicDNS could be gone for hours
// with the tick logging "dns ok", and every job on the box that named any
// OTHER tailnet host failed quietly: on 2026-09-18 every typecheck log from
// the A6 stopped reaching the CI-log sink and deploy-trigger went red, while
// the tick said the box was fine. A detector whose probe is the thing its
// own fix pins is a detector that has been switched off.
//
// THE GENERAL FORM, past DNS: a check must not check something its own
// script made always-true. A probe whose subject the checker itself
// guarantees (a pinned name, a file it wrote, a flag it set) reports green
// for as long as the guarantee holds, which is forever, and nothing about it
// can ever fail. Before writing a health check, ask what the script itself
// does to the thing the check reads; if the answer is "it makes it pass",
// the check is watching its own hand.
//
// THE RULE. In scripts/ci-runner-health.sh, the host the DNS check resolves
// (DNS_PROBE_HOST) must not be the host the script pins (GIT_HOST), and no
// `/etc/hosts` write in the script may name the probe host. Reads the script
// text; no box, no network.
//
// PROVEN RED 2026-09-18 against the script as it stood (the probe was
// $GIT_HOST) before the probe moved to the sink's host.
//
//   npx tsx scripts/lint-dns-probe-unpinned.ts   (pnpm run lint dns-probe-unpinned)
import { readFileSync } from "node:fs";

const FILE = "scripts/ci-runner-health.sh";
const src = readFileSync(FILE, "utf8");
const lines = src.split("\n");
const violations: string[] = [];

const probeLine = lines.findIndex((l) => /^\s*if\s*!\s*getent hosts\s+"\$([A-Z_]+)"/.test(l));
if (probeLine < 0) {
  violations.push(`${FILE}: no DNS probe (\`if ! getent hosts "$VAR"\`) found; the self-heal is gone`);
} else {
  const probeVar = /"\$([A-Z_]+)"/.exec(lines[probeLine]!)![1]!;
  const pinVars = new Set<string>();
  for (const l of lines) {
    const m = /echo\s+"\$[A-Z_]+\s+\$([A-Z_]+)"\s*>>\s*\/etc\/hosts/.exec(l);
    if (m) pinVars.add(m[1]!);
  }
  if (probeVar === "GIT_HOST" || pinVars.has(probeVar)) {
    violations.push(`${FILE}:${probeLine + 1}: the DNS probe resolves $${probeVar}, which the script pins in /etc/hosts, so it answers from the pin and never sees MagicDNS gone`);
  }
  if (!pinVars.size) violations.push(`${FILE}: no /etc/hosts pin found; the checkout pin (1b) is gone`);
}

if (violations.length) {
  console.error(`lint:dns-probe-unpinned - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("Probe a tailnet host the script does not pin (DNS_PROBE_HOST, the sink's host); the pinned git host resolves whether MagicDNS is up or not.");
  process.exit(1);
}
console.log("lint:dns-probe-unpinned OK: the CI box's DNS probe resolves a host the script does not pin.");
