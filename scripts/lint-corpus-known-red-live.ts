#!/usr/bin/env tsx
// A known_red marker in the chat corpus names an OPEN issue; a marker whose
// issue is closed is a stale bypass of the floor and refuses the push.
//
// THE BUG THIS PREVENTS. A `known_red: "#NNNN"` marker (chat-corpus.ts, #3101)
// holds a case out of the corpus floor until its issue is fixed. That is a
// documented bypass, and the shape of FIELD-PACK-LATER: honestly labelled,
// there for good reasons, and quietly outliving its purpose because nothing
// forced it to retire (#3107, #3147). The heal in bench-trend.mjs catches a
// case that starts passing over three runs; it does not catch the likelier
// path, where the issue merges, its cases pass, and the markers stay because
// nobody remembers they are markers. This makes the loader's condition a
// push-time rule: the moment #3123 or #3125 closes, the push is red until
// the markers go with it, so clearing them is part of the PR that fixed
// them rather than a follow-up nobody files. It also means a marker cannot
// silence a new red without an issue being filed first: a bypass has to name
// a live decision.
//
// THE RULE. Every `known_red` in CHAT_CORPUS is `#<number>` and that issue is
// OPEN on the repo's Forgejo. The check reads the Forgejo API with GATE_TOKEN
// (CI's own token), FORGEJO_TOKEN, or the ops token file; with no token or
// no route to the API it says INCONCLUSIVE and passes (a laptop off the
// tailnet must still push; CI carries the token and is the gate). No opt-out.
//
// AND THERE IS A CEILING, checked before the API and everywhere. A held-out
// case is asked LIVE on every bench run, never answered from the cache
// (lib/cache-evict.ts `served`: it is held out to be watched, and a
// remembered pass is not a watch). So every marker costs one ask per run,
// forever, and one slot of the merge run's `--max-new 40` (bench-ci.sh)
// before the run starts. At thirty markers a re-key that needs fifteen
// fresh asks pushes the budget and DEFERS the whole run, and the cause is a
// marker somebody added three weeks earlier. Past KNOWN_RED_CEILING the
// lever is the issue, not another marker.
//
// PROVEN RED 2026-09-17 against a marker on a closed issue (#3154, closed by
// #3169 the same evening) before the marker was removed.
//
//   npx tsx scripts/lint-corpus-known-red-live.ts   (pnpm run lint corpus-known-red-live)
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { CHAT_CORPUS } from "../modules/core-ai/src/chat-corpus.js";
import { secretFile } from "./lib/secret-file.mjs";

const markers = CHAT_CORPUS.filter((c) => c.known_red).map((c) => ({ say: c.say, issue: c.known_red! }));
if (!markers.length) {
  console.log("lint:corpus-known-red-live OK: no known_red marker in the corpus");
  process.exit(0);
}
/** How many cases may be held out at once: each is a live ask on every run
 *  and a slot of the merge budget (40), spoken for before the run starts. */
const KNOWN_RED_CEILING = 10;
if (markers.length > KNOWN_RED_CEILING) {
  console.error(`lint:corpus-known-red-live - ${markers.length} known_red marker(s), more than ${KNOWN_RED_CEILING}. A held-out case is asked live on every bench run (never from the cache) and takes a slot of the merge run's --max-new 40 before it starts; past ${KNOWN_RED_CEILING} the markers themselves defer merge runs. Fix an issue and clear its markers rather than adding one:`);
  for (const m of markers) console.error(`    "${m.say}": ${m.issue}`);
  process.exit(1);
}
const bad = markers.filter((m) => !/^#\d+( #\d+)*( \(.+\))?$/.test(m.issue));
if (bad.length) {
  console.error(`lint:corpus-known-red-live - ${bad.length} marker(s) do not name their issue(s) as #<number>[ #<number>...][ (why)]:`);
  for (const m of bad) console.error(`  "${m.say}": ${JSON.stringify(m.issue)}`);
  process.exit(1);
}

function token(): string {
  for (const v of [process.env.GATE_TOKEN, process.env.FORGEJO_TOKEN]) if (v && v.trim()) return v.trim();
  const f = secretFile("forgejo-claude-ops-token");
  if (existsSync(f)) {
    const line = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (line) return line;
  }
  return "";
}
function apiBase(): string {
  const env = process.env.COBBLR_FORGEJO_API;
  if (env) return env.replace(/\/$/, "");
  try {
    return execSync("bash -c '. scripts/lib/forgejo-api.sh && forgejo_api_base'", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
function repoSlug(): string {
  try {
    return execSync("bash -c '. scripts/lib/forgejo-api.sh && forgejo_repo_slug'", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "CobblrHQ/core";
  }
}

async function main(): Promise<void> {
  const tok = token();
  const base = apiBase();
  if (!tok || !base) {
    console.log(`lint:corpus-known-red-live INCONCLUSIVE: ${!tok ? "no Forgejo token here" : "no API base"}; ${markers.length} marker(s) unchecked (CI checks them)`);
    process.exit(0);
  }
  // A marker naming several issues stays until ALL of them are closed: the
  // second issue is there because the case can pass for a wrong reason until
  // it lands, so only a marker whose every issue is closed is stale.
  const issuesOf = (m: string) => [...m.replace(/\s*\(.*\)\s*$/, "").matchAll(/#(\d+)/g)].map((x) => x[1]!);
  const issues = [...new Set(markers.flatMap((m) => issuesOf(m.issue)))];
  const closed: string[] = [];
  let unreachable = "";
  for (const n of issues) {
    try {
      const r = await fetch(`${base}/api/v1/repos/${repoSlug()}/issues/${n}`, { headers: { Authorization: `token ${tok}` }, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) {
        closed.push(`#${n} (no such issue)`);
        continue;
      }
      if (!r.ok) {
        unreachable = `HTTP ${r.status} on issue #${n}`;
        break;
      }
      const j = (await r.json()) as { state?: string };
      if (j.state === "closed") closed.push(`#${n}`);
    } catch (err) {
      unreachable = String((err as Error).message ?? err).slice(0, 80);
      break;
    }
  }
  if (unreachable) {
    console.log(`lint:corpus-known-red-live INCONCLUSIVE: the Forgejo API did not answer (${unreachable}); ${markers.length} marker(s) unchecked (CI checks them)`);
    process.exit(0);
  }
  const closedSet = new Set(closed.map((c) => c.split(" ")[0]!.slice(1)));
  const stale = markers.filter((m) => issuesOf(m.issue).every((n) => closedSet.has(n)));
  if (stale.length) {
    console.error(`lint:corpus-known-red-live - ${stale.length} known_red marker(s) name only CLOSED issue(s) (${closed.join(", ")}), so they are a stale bypass of the corpus floor:`);
    for (const m of stale) console.error(`    "${m.say}": ${m.issue}`);
    console.error("Remove these markers from KNOWN_RED in modules/core-ai/src/chat-corpus.ts (the PR that fixed the issue is where they go). A case that still fails without its marker is a new finding: file it and mark it against THAT issue.");
    process.exit(1);
  }
  console.log(`lint:corpus-known-red-live OK: ${markers.length} known_red marker(s) name ${issues.length} issue(s) (${issues.map((n) => `#${n}`).join(", ")}), none stale${closed.length ? `; closed but still held by another open issue: ${closed.join(", ")}` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
