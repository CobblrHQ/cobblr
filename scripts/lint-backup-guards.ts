/**
 * There is ONE database dump loop, it lives in the db image, and it cannot lie
 * about succeeding.
 *
 * THE HISTORY THIS ENFORCES. `pg_dumpall | gzip` reports the status of gzip,
 * which succeeds on empty input. So `if pg_dumpall --clean | gzip > "$OUT";
 * then echo done; fi` calls a refused connection a backup, writes a 20-byte
 * file, and sleeps a full day. That hid a three-day outage when a pinned pg17
 * client met a pg18 server, and on 2026-09-05 it logged "done - 20 bytes" on
 * staging while the db container was being recreated, then slept 24h.
 *
 * WHY THE RULE IS NOW "ONE COPY" AND NOT "EACH COPY IS GUARDED". The guarded
 * loop was written twice (prod's overlay, the self-host template) and this lint
 * kept those two honest. It could not see the other two: the tracked compose in
 * the sibling ops repo, and whatever each box actually runs. On 2026-09-22 the
 * ops copy still trusted the pipeline's exit status AND still pinned
 * `postgres:17-alpine` against an 18 server — both of the failures above, in the
 * file a redeploy would use, two weeks after they were fixed everywhere this
 * lint could read. Four copies of one loop is the bug; the guards are symptoms.
 *
 * So:
 *   1. docker/backup-loop.sh exists and carries the guards (a size floor, a
 *      retry sooner than a day, an anchored dump hour, the ordering marker);
 *   2. a compose file that dumps a database CALLS it — `entrypoint:
 *      ["/usr/local/bin/backup-loop.sh"]` — and inlines no loop of its own;
 *   3. no backup service pins a `postgres:N` client image.
 *
 * Rule 2 covers core's deploy/ tree AND the sibling server-setup checkout when
 * it is present — the arrangement lint:alert-lib-sync uses for the same kind of
 * cross-repo fact: invisible in CI, caught on the machine that has both.
 * Override the sibling path with BACKUP_GUARDS_SIBLING.
 *
 * PROVE IT RED before trusting it green: put a `while true` dump loop back into
 * any compose file, or delete the retry from the script, and run it.
 *
 * Run: npx tsx scripts/lint-backup-guards.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const LOOP = "docker/backup-loop.sh";
const CALL = "/usr/local/bin/backup-loop.sh";
// Two levels up, not one: the checkouts sit side by side under GitHub/, and
// core is nested a directory deeper (GitHub/CobblrHQ/core). Same path
// lint:alert-lib-sync resolves.
const SIBLING = process.env.BACKUP_GUARDS_SIBLING ?? resolve(ROOT, "../../server-setup");

function composeFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      composeFiles(p, out);
    } else if (/^(docker-)?compose.*\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];

// ── 1. the one loop, and its guards ─────────────────────────────────────────
const loopPath = join(ROOT, LOOP);
if (!existsSync(loopPath)) {
  failures.push(`${LOOP} is missing: the dump loop is a tested file in the db image, not a compose string.`);
} else {
  // Comment lines are skipped: the file DOCUMENTS the old broken shape to
  // explain why it is wrong, and a lint that fires on its own explanation
  // teaches people to delete the explanation.
  const code = readFileSync(loopPath, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  if (/if\s+pg_dumpall[^\n]*\|\s*gzip[^\n]*;\s*then/.test(code)) {
    failures.push(
      `${LOOP}: \`if pg_dumpall … | gzip; then\` trusts the pipeline's exit status.\n` +
        `    A pipeline reports its LAST command and gzip succeeds on empty input, so a refused\n` +
        `    connection reads as a successful backup. Gate on SIZE instead.`,
    );
  }
  const required: Array<[RegExp, string]> = [
    [/BACKUP_MIN_BYTES/, "has no size floor; exit status cannot be trusted here, size can"],
    [/retry/i, "has no retry sooner than a day; a container recreate must not cost a day of coverage"],
    [/BACKUP_AT|secs_until/, "does not anchor the dump hour; a loop that sleeps a flat day inherits its hour from the last `compose up` (#3307)"],
    [/last-dump/, "does not write the last-dump marker an off-box copy orders itself on (#3307)"],
  ];
  for (const [re, why] of required) {
    if (!re.test(code)) failures.push(`${LOOP} ${why}.`);
  }
}

// ── 2 + 3. every compose that dumps a database calls it ─────────────────────
const scopes: Array<{ label: string; dir: string }> = [{ label: "core", dir: join(ROOT, "deploy") }];
if (existsSync(SIBLING)) {
  scopes.push({ label: "server-setup", dir: SIBLING });
} else {
  console.log(`(no sibling ops checkout at ${SIBLING} — its compose files are checked on a machine that has both)`);
}

for (const scope of scopes) {
  for (const file of composeFiles(scope.dir)) {
    const body = readFileSync(file, "utf8");
    if (!body.includes("pg_dumpall")) continue;
    const rel = file.startsWith(ROOT) ? file.slice(ROOT.length) : `${scope.label}:${file.slice(SIBLING.length + 1)}`;

    if (!body.includes(CALL)) {
      failures.push(
        `${rel}: dumps a database without calling ${CALL}.\n` +
          `    The loop lives in the db image (${LOOP}) and is tested there. An inline copy is how a\n` +
          `    refused-connection-reads-as-success loop survived in one file for two weeks after being\n` +
          `    fixed in the others. Use:\n` +
          `      entrypoint: ["${CALL}"]\n` +
          `    and pass BACKUP_AT / BACKUP_PREFIX / BACKUP_MIN_BYTES as environment.`,
      );
    }
    if (/while\s+true;\s*do/.test(body)) {
      failures.push(`${rel}: still inlines a dump loop (\`while true; do\` beside pg_dumpall). One loop, in the image.`);
    }
    // pg_dumpall refuses a server NEWER than the client, silently, by dumping
    // nothing — so the client image must not be pinned behind the db image.
    if (/image:\s*postgres:\d+/.test(body)) {
      failures.push(
        `${rel}: a backup service pins a \`postgres:N\` client image. pg_dumpall refuses a server NEWER\n` +
          `    than the client, so this starts failing the day the db image crosses a major — it did:\n` +
          `    a 17 client against an 18 server dumped 20 bytes and reported success. Use the project's\n` +
          `    own db image, so the pair cannot skew.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("lint:backup-guards FAILED — a backup that can lie about succeeding, or a second copy of the loop\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log("lint:backup-guards: ok — one tested dump loop in the image, called by every compose that dumps");
