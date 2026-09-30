#!/usr/bin/env tsx
// A readiness wait on a postgres container (docker exec … pg_isready, or a psql 'select 1' poll) asks over TCP (-h 127.0.0.1), which only the real server answers, never the unix socket the entrypoint's bootstrap server also answers on.
//
// THE BUG THIS PREVENTS. core-db's upgrade smoke test passed its wait on the bootstrap server and the next statement hit the gap before the real server started; main's Docker Build went red on a fast runner (2026-09-29)
//
// THE RULE. A line that runs `docker exec … pg_isready`, or `docker exec …
// psql … select 1` (the readiness poll), must pass `-h` (a TCP host). The
// stock postgres entrypoint initialises a fresh cluster on a temporary server
// with listen_addresses='' that answers on the unix socket, stops it, then
// starts the real server; a socket check can pass in the first and the next
// command land in the gap. `# socket-ok: <why>` on the line opts out, for a
// container whose only socket server is the real one.
//
// THE BOUNDARY. Only readiness checks: after a TCP wait has seen the real
// server, later socket queries on the same container are fine, so ordinary
// `docker exec … psql` statements are not judged. Scope is the shell that CI,
// deploys and ops run: workflows, deploy/, docker/ and scripts/ shell files.
//
//   npx tsx scripts/lint-postgres-ready-over-tcp.ts   (pnpm lint postgres-ready-over-tcp)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.js";

const FILES = [".forgejo/workflows/*.yml", "deploy/*.sh", "docker/*.sh", "scripts/*.sh", "scripts/**/*.sh"];
const READY = /docker\s+exec\b.*\b(?:pg_isready\b|psql\b.*\bselect 1\b)/i; // pg-readiness: ok — the pattern this lint looks for, not a probe

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (READY.test(line) && !/\s-h\s/.test(line) && !/#\s*socket-ok:\s*\S/.test(line)) {
      out.push({ file, line: i + 1, what: "a postgres readiness check over the unix socket" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const file of [...new Set(repoFiles(FILES))]) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:postgres-ready-over-tcp - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add -h 127.0.0.1 to the readiness check, or '# socket-ok: <why>' on the line when the only socket server is the real one");
  process.exit(1);
}
console.log(`lint:postgres-ready-over-tcp OK`);
