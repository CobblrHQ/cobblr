#!/usr/bin/env tsx
// Every invokable action says who runs it: runBy (a role, or requester), or grantedAs, and a runBy above member says why on an ADMIN-ONLY line above it, so a member is never refused at the API what the page lets them do.
//
// THE BUG THIS PREVENTS. A member made orders on the Sales page and was
// refused sales:create-order through the API and Cobb (2026-10-07, #5170).
// An action that declared nothing was the admin tier's by default, silently,
// whatever the page beside it let a member do; 121 of 191 said nothing.
//
// THE RULE. A module action (an `id:` with an `invokeHandler` in a
// modules/*/src/module.ts) says one of:
//   - `runBy: "member"`: the page lets a member make the same write;
//   - `runBy: "requester"`: the person who started what it answers runs it,
//     and a registerRequester for its handler exists in that module;
//   - `grantedAs: "<capability>"`: the page's twin gates on that capability;
//   - `runBy: "admin"` (or editor, owner) with `// ADMIN-ONLY: <why>` on the
//     line above it, naming the page gate or the reason there is no twin.
// A kernel action in api/src/platform/platform-actions.ts whose min_role is
// member or guest says run_by, the same way: its floor already lets a member
// past, so saying nothing refuses them at the door by accident. A member
// default capability (api/src/platform/member-defaults.ts) needs nothing; the
// member already holds it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A panel or an entity kind
// carries an `id:` too (digifab:print-this is a panel and an action); only an
// id whose own block has an invokeHandler is an action. Kernel actions with
// min_role admin, owner or grantable say who runs them already.
//
//   npx tsx scripts/lint-every-action-says-who-runs-it.ts   (pnpm lint every-action-says-who-runs-it)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { manifestSources } from "./lib/manifest-sources.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const ID = /(?<![\w$])id:\s*"([a-z0-9-]+:[a-z0-9-]+)"/;
const memberDefaults = new Set(
  [...readFileSync("api/src/platform/member-defaults.ts", "utf8").matchAll(/"([a-z0-9-]+:[a-z0-9-]+)"/g)].map((m) => m[1]!),
);

/** The lines of the block an `id:` opens: up to the next id. */
function blockAt(lines: string[], i: number): { text: string; lines: number[] } {
  const own: number[] = [i];
  for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
    if (ID.test(lines[j]!)) break;
    own.push(j);
  }
  return { text: own.map((j) => lines[j]).join("\n"), lines: own };
}

export function checkModule(file: string, src: string, moduleSrc: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ID.exec(lines[i]!);
    if (!m) continue;
    const id = m[1]!;
    const block = blockAt(lines, i);
    const handler = /invokeHandler:\s*"([^"]+)"/.exec(block.text)?.[1];
    if (!handler || memberDefaults.has(id)) continue;
    const runBy = /\brunBy:\s*"(\w+)"/.exec(block.text)?.[1];
    const granted = /\bgrantedAs:\s*"/.test(block.text);
    if (!runBy && !granted) {
      out.push({ file, line: i + 1, what: `${id} does not say who runs it: runBy "member" where the page lets a member make the same write, grantedAs the page's capability, or runBy "admin" with an ADMIN-ONLY reason` });
      continue;
    }
    if (runBy === "requester" && !new RegExp(`registerRequester\\(\\s*"${handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(moduleSrc)) {
      out.push({ file, line: i + 1, what: `${id} is run by its requester, but nothing calls registerRequester("${handler}") to say who that is` });
    }
    if (runBy && runBy !== "member" && runBy !== "requester") {
      const at = block.lines.find((j) => /\brunBy:\s*"/.test(lines[j]!))!;
      if (!/\/\/ ADMIN-ONLY: \S/.test(lines[at - 1] ?? "")) out.push({ file, line: at + 1, what: `${id} is runBy "${runBy}" with no // ADMIN-ONLY: <why> on the line above` });
    }
  }
  return out;
}

export function checkKernel(file: string, src: string, requesterLines: readonly string[]): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = ID.exec(lines[i]!);
    if (!m || !m[1]!.startsWith("platform:")) continue;
    const block = blockAt(lines, i).text;
    const floor = /min_role:\s*"(\w+)"/.exec(block)?.[1];
    const handler = /invoke_handler:\s*"([^"]+)"/.exec(block)?.[1];
    if (/\brun_by:\s*"requester"/.test(block) && handler && !requesterLines.some((l) => l.includes(`"${handler}"`))) {
      out.push({ file, line: i + 1, what: `${m[1]} is run by its requester, but no registerRequester line names "${handler}"` });
    }
    if ((floor === "member" || floor === "guest") && !/\brun_by:\s*"/.test(block)) {
      out.push({ file, line: i + 1, what: `${m[1]} lets a ${floor} past its floor but says no run_by, so the door refuses them anyway: say run_by "member" or "requester"` });
    }
  }
  return out;
}

const read = (dir: string): string => {
  let all = "";
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    } catch {
      return;
    }
    for (const n of names) {
      if (n.endsWith("/")) {
        if (n !== "node_modules/" && n !== "dist/") walk(join(d, n));
      } else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) all += readFileSync(join(d, n), "utf8");
    }
  };
  walk(dir);
  return all;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const mod of readdirSync("modules")) for (const file of manifestSources(join("modules", mod))) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    violations.push(...checkModule(file, src, read(join("modules", mod, "src"))));
  }
  const kernel = "api/src/platform/platform-actions.ts";
  const requesterLines = read("api/src/platform").split("\n").filter((l) => l.includes("registerRequester("));
  violations.push(...checkKernel(kernel, readFileSync(kernel, "utf8"), requesterLines));
  if (violations.length) {
    console.error(`lint:every-action-says-who-runs-it - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Read the page's own gate for the same write and say it on the action (docs/modules/member-portal-and-permissions.md §2.2b).");
    process.exit(1);
  }
  console.log("lint:every-action-says-who-runs-it OK");
}
