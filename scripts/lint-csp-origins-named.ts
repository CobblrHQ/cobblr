#!/usr/bin/env tsx
// Every external https origin the shipped web code names is either allowed by the enforced Content-Security-Policy in docker/nginx.conf or listed in scripts/csp-origins.json with why the browser never loads it, so a page that starts using a new host fails CI until the policy names it.
//
// THE BUG THIS PREVENTS. 2026-10-11: the policy went from report-only to
// enforced (#3300). A host the web code starts loading that the policy does not
// name is refused in every browser: a script that never runs, a call that never
// leaves, a frame that stays blank. Report-only, that was a console line; now
// it is a broken page.
//
// THE RULE. Each `https://<host>` written in shipped browser code (web/src,
// packages/platform-web/src, modules/*/src/ui; tests excluded) must either be a
// host the enforced policy names in some directive, or be listed in
// scripts/csp-origins.json with a sentence saying why the browser never loads
// it: a link a person follows, a placeholder, an image (img-src allows any
// https image), a URL handed to the api. A new host fails until one of the two
// is true, which is the decision the policy needs someone to make.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Most hosts in the code are
// never loaded by the browser at all: duckduckgo.com is a link, hooks.slack.com
// a placeholder, api.formlabs.com a base URL the api calls. Telling a load from
// a mention needs a browser, which e2e/csp-enforced.mjs is (csp-shell.yml on
// every web pull request). So this lint does not guess: it makes a new host a
// listed decision, and the walk proves the loads.
//
//   npx tsx scripts/lint-csp-origins-named.ts   (pnpm lint csp-origins-named)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Browser code only: the api's own outbound calls are not under any page's policy. */
const ROOTS = ["web/src", "packages/platform-web/src", ...uiRoots()];
const LISTED = "scripts/csp-origins.json";

function uiRoots(): string[] {
  try {
    return readdirSync("modules").map((m) => join("modules", m, "src", "ui"));
  } catch {
    return [];
  }
}

interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The hosts the enforced policy names, in any directive. */
function policyHosts(): Set<string> {
  const conf = readFileSync("docker/nginx.conf", "utf8");
  const m = conf.match(/map \$cobblr_own_csp \$cobblr_csp_enforce \{[\s\S]*?default "([^"]+)";/);
  if (!m) throw new Error("docker/nginx.conf: no enforced $cobblr_csp_enforce map");
  return new Set([...m[1]!.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((x) => x[1]!.toLowerCase()));
}

const named = policyHosts();
const listed: Record<string, string> = JSON.parse(readFileSync(LISTED, "utf8"));
const reasonless = Object.entries(listed).filter(([k, why]) => !k.startsWith("_") && (typeof why !== "string" || why.trim().length < 12));

const violations: Violation[] = [];
const seen = new Set<string>();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
        const host = m[1]!.toLowerCase();
        seen.add(host);
        if (named.has(host) || host in listed) continue;
        violations.push({ file, line: i + 1, what: `https://${host} is not named by the enforced CSP and not listed in ${LISTED}` });
      }
    });
  }
}
// A listed host the code no longer names is a stale exemption: it would let the next
// use of that host through unexamined.
const stale = Object.keys(listed).filter((h) => !h.startsWith("_") && !seen.has(h));

if (violations.length || reasonless.length || stale.length) {
  console.error(`lint:csp-origins-named - ${violations.length + reasonless.length + stale.length} problem(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  for (const [h] of reasonless) console.error(`  ${LISTED}: "${h}" needs a sentence saying why the browser never loads it`);
  for (const h of stale) console.error(`  ${LISTED}: "${h}" is no longer in the web code; remove it`);
  console.error("A host the page LOADS goes into docker/nginx.conf's enforced policy (and e2e/csp-enforced.mjs's third-party list);");
  console.error(`a host it only MENTIONS (a link, a placeholder, an image, a URL the api calls) goes into ${LISTED} with why.`);
  process.exit(1);
}
console.log(`lint:csp-origins-named OK (${seen.size} hosts: ${[...seen].filter((h) => named.has(h)).length} named by the policy, the rest listed)`);
