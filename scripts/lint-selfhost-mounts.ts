// Guard: every api-service bind mount in a shipped deploy stack must target a
// path the app is actually TOLD to write to (an env var value in that stack).
//
// The trap this catches: the standalone self-host stack mounted ./data/files
// at /files and ./data/modules at /app/installed-modules — paths the app never
// writes — while uploads went to the code default (/app/_files) and runtime
// modules to /var/cobblr/sandboxed-modules, both inside the container's
// writable layer. The stack even documented "copying ./data is a complete
// backup." Result: `docker compose pull && up -d` (the documented update)
// silently discarded every uploaded photo and installed module. The dev stack
// set the env vars correctly, so nobody in-house ever hit it — it only broke
// in the stack we hand to other people.
//
// The rule, mechanically: for each deploy/**/docker-compose*.yml whose `api:`
// service declares bind mounts, every mount's CONTAINER target must equal the
// value of some env var set on the api service — in that file, or (for overlay
// files layered on the repo-root compose) in the base docker-compose.yml.
// An env-var-backed target is one the app demonstrably reads; a mount to any
// other path is a dead mount and almost certainly this bug again.
// Run: npx tsx scripts/lint-selfhost-mounts.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface ApiService {
  envPaths: Set<string>;
  mounts: { line: number; target: string; raw: string }[];
}

/** Minimal compose reader — enough for our own controlled files. Finds the
 *  `api:` service (2-space indent), then its `environment:` mapping values and
 *  `volumes:` list entries. Not a YAML parser; if these files grow YAML
 *  features this can't read, switch to a real parser rather than loosening it. */
function readApiService(path: string): ApiService {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: ApiService = { envPaths: new Set(), mounts: [] };
  let inApi = false;
  let section: "env" | "volumes" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const serviceHead = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (serviceHead) {
      inApi = serviceHead[1] === "api";
      section = null;
      continue;
    }
    if (!inApi) continue;
    if (/^ {4}environment:\s*$/.test(line)) {
      section = "env";
      continue;
    }
    if (/^ {4}volumes:/.test(line)) {
      // matches `volumes:` and `volumes: !override`
      section = "volumes";
      continue;
    }
    if (/^ {4}[A-Za-z0-9_-]+:/.test(line)) {
      section = null; // some other api key
      continue;
    }
    if (section === "env") {
      const kv = line.match(/^ {6}[A-Z0-9_]+:\s*(\S.*)$/);
      const v = kv?.[1]?.trim();
      if (v && v.startsWith("/")) out.envPaths.add(v);
    }
    if (section === "volumes") {
      const entry = line.match(/^ {6}-\s*(\S+)\s*$/);
      if (!entry) continue;
      const parts = entry[1]!.split(":");
      if (parts.length >= 2) {
        out.mounts.push({ line: i + 1, target: parts[1]!, raw: entry[1]! });
      }
    }
  }
  return out;
}

function composeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...composeFiles(p));
    else if (/^docker-compose.*\.ya?ml$/.test(name)) found.push(p);
  }
  return found;
}

const base = readApiService("docker-compose.yml");
const failures: string[] = [];
let checkedMounts = 0;

for (const file of composeFiles("deploy")) {
  const svc = readApiService(file);
  if (svc.mounts.length === 0) continue;
  const allowed = new Set([...svc.envPaths, ...base.envPaths]);
  for (const m of svc.mounts) {
    checkedMounts++;
    if (!allowed.has(m.target)) {
      failures.push(
        `${file}:${m.line} mounts "${m.raw}" but no api env var (here or in the base compose) points the app at ${m.target} — a dead mount; data written to the code default is lost on every update`,
      );
    }
  }
}

if (failures.length) {
  console.error("✗ lint-selfhost-mounts: dead bind mounts in shipped stacks:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ selfhost-mounts lint: ${checkedMounts} api bind mount(s) across deploy/ stacks all target env-var-backed paths`,
);
process.exit(0);
