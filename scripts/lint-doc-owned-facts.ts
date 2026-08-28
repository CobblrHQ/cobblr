#!/usr/bin/env tsx
// One doc owns each operational fact; everybody else links to it.
//
// THE MISTAKE THIS PREVENTS. On 2026-08-29 an agent was asked why a workspace's
// Discord updates arrived twice. Part of the answer needed "does the canary
// update on every merge?", and it answered NO — from
// `docs/design-decisions/canary-channel.md`, which said ":latest, Watchtower
// on", and from the container's `watchtower.enable=false` label, which looks
// like confirmation. Both readings were wrong. Canary moved off Watchtower on
// 2026-08-17 (Watchtower stop-starts a container and kills in-flight requests);
// it is rolled blue-green by `canary-roll.timer`, and it had in fact picked up
// the merge minutes earlier.
//
// The truth WAS written down — in `docs/operations/CI_DEPLOY.md`, correctly and
// in detail, including that same label and why it is false. Two docs described
// one mechanism; one was maintained and the other rotted. The reader cannot
// tell which is which, so the stale one is indistinguishable from an answer.
//
// So: an operational fact has exactly ONE owning doc. Another doc may refer to
// it, but only by LINKING the owner — never by restating it, because a restated
// fact is a copy that nobody updates.
//
// Adding a rule is a ROW here, not a new script (the capability-registry
// pattern). A row is worth adding when a fact is (a) operational — it describes
// what the running system does, so it can go out of date — and (b) already
// written in more than one place.
//
//   cd <repo> && npx tsx scripts/lint-doc-owned-facts.ts

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface OwnedFact {
  /** What the fact is, for the failure message. */
  what: string;
  /** The doc that owns it. Every other mention must link here. */
  owner: string;
  /** The section a linking mention should point at (an anchor in `owner`). */
  anchor: string;
  /** Prose that RESTATES the fact rather than linking it. Keep these tight:
   *  a rule that also flags neighbouring true sentences is one people learn to
   *  silence, and the doc's other watchtower mentions (a port table, the CI
   *  poke) are correct and must stay unflagged. */
  claims: RegExp[];
}

const FACTS: OwnedFact[] = [
  {
    what: "how the canary pair picks up a new build (canary-roll.timer, blue-green; Watchtower is deliberately OFF for it)",
    owner: "docs/operations/CI_DEPLOY.md",
    anchor: "#canary-rolls-blue-green-not-via-watchtower-changed-2026-08-17",
    claims: [
      // "Watchtower on" / "Watchtower enabled" — the two lines that were still
      // saying it eighteen days after canary moved off Watchtower.
      /watchtower\s+(on|enabled)\b/i,
      // Any other phrasing that has Watchtower doing the updating for canary.
      /watchtower[^.\n]{0,50}\b(updates?|rolls?|deploys?|picks up|replaces?)\b[^.\n]{0,50}canary/i,
      /canary[^.\n]{0,50}\b(updated|rolled|deployed|replaced)\b[^.\n]{0,30}by[^.\n]{0,20}watchtower/i,
    ],
  },
];

const DOC_DIRS = ["docs"];
const SKIP = /(\/history\/|\/node_modules\/)/; // history is frozen on purpose

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(`/${p}/`)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

const findings: string[] = [];
for (const fact of FACTS) {
  for (const dir of DOC_DIRS) {
    for (const file of walk(dir)) {
      if (file === fact.owner) continue; // the owner may say it in full
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        if (!fact.claims.some((re) => re.test(line))) return;
        // A mention that LINKS the owner is a pointer, not a copy.
        if (line.includes(fact.owner) || line.includes(fact.anchor)) return;
        findings.push(
          `  ${file}:${i + 1}\n    ${line.trim().slice(0, 120)}\n` +
            `    → ${fact.what} is owned by ${fact.owner}${fact.anchor}. Link it instead of restating it.`,
        );
      });
    }
  }
}

if (findings.length) {
  console.error(
    `✗ doc-owned-facts: ${findings.length} doc line(s) restate an operational fact another doc owns.\n` +
      `  A copy is a fact nobody updates: this exact shape sent an agent to the wrong\n` +
      `  answer about the canary channel on 2026-08-29.\n`,
  );
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log("lint:doc-owned-facts ✓ operational facts are stated once and linked everywhere else.");
