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
// PROVEN RED 2026-09-17 against a marker on a closed issue (#3154, closed by
// #3169 the same evening) before the marker was removed.
//
//   npx tsx scripts/lint-corpus-known-red-live.ts   (pnpm run lint:corpus-known-red-live)
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { CHAT_CORPUS } from "../modules/core-ai/src/chat-corpus.js";
import { secretFile } from "./lib/secret-file.mjs";

const markers = CHAT_CORPUS.filter((c) => c.known_red).map((c) => ({ say: c.say, issue: c.known_red! }));
if (!markers.length) {
  console.log("lint:corpus-known-red-live OK: no known_red marker in the corpus");
  process.exit(0);
}
const bad = markers.filter((m) => !/^#\d+$/.test(m.issue));
if (bad.length) {
  console.error(`lint:corpus-known-red-live - ${bad.length} marker(s) do not name an issue as #<number>:`);
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
  const issues = [...new Set(markers.map((m) => m.issue.slice(1)))];
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
  if (closed.length) {
    console.error(`lint:corpus-known-red-live - ${closed.length} known_red issue(s) are CLOSED, so their markers are a stale bypass of the corpus floor:`);
    for (const c of closed) {
      console.error(`  ${c}:`);
      for (const m of markers.filter((m) => m.issue === c.split(" ")[0])) console.error(`    "${m.say}"`);
    }
    console.error("Remove these markers from KNOWN_RED in modules/core-ai/src/chat-corpus.ts (the PR that fixed the issue is where they go). A case that still fails without its marker is a new finding: file it and mark it against THAT issue.");
    process.exit(1);
  }
  console.log(`lint:corpus-known-red-live OK: ${markers.length} known_red marker(s) name ${issues.length} open issue(s) (${issues.map((n) => `#${n}`).join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
