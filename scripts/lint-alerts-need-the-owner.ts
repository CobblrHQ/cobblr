#!/usr/bin/env tsx
// Only an alert that needs the owner reaches the infra channel: nothing posts to the infra webhook but scripts/lib/open-alert.mjs, and every red alert says its audience, owner or fleet, and a fleet one when it escalates.
//
// THE BUG THIS PREVENTS. #6203, 2026-10-13, the owner: "Do I need to receive these alerts every time?" and
// then "limit the existing alerts to ones that need my attention, ie: unresolved or unfixable by you". About
// twenty scripts and workflow steps posted straight to the infra webhook the moment anything went red (a
// failed bake, a red main, a mirror publish, a nightly walk), whatever the fleet was already doing about it.
//
// THE RULE.
//   1. Only scripts/lib/open-alert.mjs (and the door over it, scripts/lib/alert.mjs) sends to the infra webhook.
//      Anywhere else in scripts/ or .forgejo/workflows/, a fetch, curl or urllib call whose target is the infra
//      webhook (INFRA_WEBHOOK, INFRA_ALERT_WEBHOOK) fails. Raise through the door instead.
//   2. A raiseOpenAlert call with severity "red" passes `audience:`, and a fleet one `escalateAfterMin:`;
//      `node scripts/lib/alert.mjs raise` passes `--audience`, and a fleet one `--after`.
// A yellow alert never posts and needs neither.
//
// THE BOUNDARY. Reading the variable to hand it on (`INFRA_WEBHOOK: ${{ secrets.INFRA_ALERT_WEBHOOK }}`, a
// `webhook: process.env.INFRA_WEBHOOK` argument) is how a source reaches the door, and passes. Announcements
// (the changelog and release channels, CHANGELOG_DISCORD_WEBHOOK) are not alerts and are not judged. Box
// scripts post through box-alert.sh, which holds its own alerts (#6203's second half).
//
//   npx tsx scripts/lint-alerts-need-the-owner.ts   (pnpm lint alerts-need-the-owner)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.COBBLR_LINT_ROOT || ".";
const DOOR = new Set(["scripts/lib/open-alert.mjs", "scripts/lib/alert.mjs"]);
const SELF = "scripts/lint-alerts-need-the-owner.ts";
const COMMENT = /^\s*(\/\/|#|\*)/;

export interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(join(ROOT, dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".") && dir !== "" && name !== ".forgejo") continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(ROOT, rel)).isDirectory()) yield* walk(rel);
    else if (/\.(mjs|ts|sh|yml|yaml)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield rel;
  }
}

const SENDS = /(fetch\(\s*process\.env\.INFRA_(ALERT_)?WEBHOOK|curl[^\n]*"\$\{?INFRA_(ALERT_)?WEBHOOK\}?"|python3 - "\$\{?INFRA_(ALERT_)?WEBHOOK)/;

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file === SELF) return out;
  const lines = src.split("\n");
  if (!DOOR.has(file)) {
    lines.forEach((l, i) => {
      if (SENDS.test(l) && !COMMENT.test(l)) out.push({ file, line: i + 1, what: "posts to the infra webhook directly: raise through scripts/lib/alert.mjs (or raiseOpenAlert) with its audience" });
    });
  }
  // raiseOpenAlert({ ... severity: "red" ... }): one call, up to its closing parenthesis.
  for (const m of src.matchAll(/raiseOpenAlert\(\{/g)) {
    if (DOOR.has(file)) break;
    let depth = 0;
    let end = m.index!;
    for (let k = m.index! + "raiseOpenAlert(".length; k < src.length; k++) {
      const ch = src[k];
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") {
        if (depth === 0) {
          end = k;
          break;
        }
        depth--;
      }
    }
    const call = src.slice(m.index!, end);
    const line = src.slice(0, m.index!).split("\n").length;
    if (!/severity:\s*"red"/.test(call)) continue;
    if (!/\baudience:/.test(call)) out.push({ file, line, what: "a red alert with no audience: say audience: \"owner\" (unfixable by the fleet, or user-facing) or \"fleet\"" });
    else if (/audience:\s*"fleet"/.test(call) && !/escalateAfterMin:/.test(call)) out.push({ file, line, what: "a fleet alert says when it becomes the owner's: escalateAfterMin" });
  }
  lines.forEach((l, i) => {
    if (DOOR.has(file) || !/alert\.mjs raise\b/.test(l) || COMMENT.test(l)) return;
    if (!/--audience (owner|fleet)\b/.test(l)) out.push({ file, line: i + 1, what: "alert.mjs raise with no --audience owner|fleet" });
    else if (/--audience fleet\b/.test(l) && !/--after \d+/.test(l)) out.push({ file, line: i + 1, what: "a fleet alert says when it becomes the owner's: --after <minutes>" });
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const root of ["scripts", ".forgejo/workflows"]) for (const f of walk(root)) violations.push(...check(f, readFileSync(join(ROOT, f), "utf8")));
  if (violations.length) {
    console.error(`lint:alerts-need-the-owner - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Only what needs the owner reaches the infra channel (#6203): raise through scripts/lib/alert.mjs with --audience owner|fleet.");
    process.exit(1);
  }
  console.log("lint:alerts-need-the-owner OK");
}
