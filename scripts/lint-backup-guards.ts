/**
 * A backup loop must not be able to report success on a failed dump.
 *
 * `pg_dumpall | gzip` reports the status of gzip, which succeeds on empty input.
 * So `if pg_dumpall --clean | gzip > "$OUT"; then echo done; fi` calls a refused
 * connection a backup, writes a 20-byte file, and sleeps a full day. That is not
 * hypothetical twice over: it hid a three-day outage when a pinned pg17 client
 * met a pg18 server, and on 2026-09-05 it logged "done - 20 bytes" on staging
 * while the db container was being recreated, then slept 24h. Prod survived the
 * same second because its copy had a size floor and a retry.
 *
 * WHY A LINT: the guarded version was written twice (prod's stack, then the
 * self-host template) and the tracked compose that staging runs kept the
 * original. Three copies of one loop, and the one nobody looked at is the one
 * that failed. A lint is the only thing that reads all three.
 *
 * Each shipped backup loop must therefore:
 *   1. set -euo pipefail          — so the pipeline's real status survives
 *   2. gate on a SIZE floor       — exit status alone cannot be trusted
 *   3. retry sooner than a day    — a blip must not cost a day of coverage
 *
 * Run: npx tsx scripts/lint-backup-guards.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function composeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) composeFiles(p, out);
    else if (/^(docker-)?compose.*\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];

for (const file of composeFiles(join(ROOT, "deploy"))) {
  const body = readFileSync(file, "utf8");
  if (!body.includes("pg_dumpall")) continue;
  const rel = file.replace(ROOT, "");

  // The shape that started all of this: trusting a pipeline's exit status.
  // Comment lines are skipped: the fixed file DOCUMENTS the old shape to explain
  // why it is wrong, and a lint that fires on its own explanation teaches people
  // to delete the explanation.
  const code = body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  if (/if\s+pg_dumpall[^\n]*\|\s*gzip[^\n]*;\s*then/.test(code)) {
    failures.push(
      `${rel}: \`if pg_dumpall … | gzip; then\` trusts the pipeline's exit status.\n` +
        `    A pipeline reports its LAST command, and gzip succeeds on empty input, so a\n` +
        `    refused connection reads as a successful backup. Gate on SIZE instead.`,
    );
  }
  if (!body.includes("set -euo pipefail")) {
    failures.push(`${rel}: the backup entrypoint is missing \`set -euo pipefail\`.`);
  }
  if (!body.includes("BACKUP_MIN_BYTES")) {
    failures.push(
      `${rel}: the backup loop has no BACKUP_MIN_BYTES floor. Exit status cannot be\n` +
        `    trusted here; size is the check that does not depend on a failure reporting\n` +
        `    itself honestly.`,
    );
  }
  // A failed dump that sleeps a full day turns a seconds-long blip into a day
  // with no restore point, which is exactly how 2026-09-05 cost staging its.
  if (body.includes("sleep 86400") && !/retry/i.test(body)) {
    failures.push(
      `${rel}: a failed dump waits a full day. Retry on a shorter clock so a container\n` +
        `    recreate does not cost a day of coverage.`,
    );
  }
  // pg_dumpall refuses a server newer than the client, silently, by dumping
  // nothing — so the client image must not be pinned behind the db image.
  if (/image:\s*postgres:\d+/.test(body)) {
    failures.push(
      `${rel}: the backup client is a pinned \`postgres:N\` image. pg_dumpall refuses a\n` +
        `    server NEWER than the client, so this starts failing the day the db image\n` +
        `    crosses a major. Use the project's own db image so they cannot skew.`,
    );
  }
}

if (failures.length > 0) {
  console.error("lint:backup-guards FAILED — a backup that can lie about succeeding\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log("lint:backup-guards: ok — every shipped backup loop gates on size and retries");
