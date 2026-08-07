// Guard: a Postgres readiness probe must name the DATABASE it is gating on.
//
// THE CLASS, which bit twice on 2026-08-07/08:
//   `pg_isready -U cobblr` asks one question — "is the SERVER accepting
//   connections?" — and answers it about a database name it INVENTS: with no
//   `-d`, pg_isready defaults the dbname to the username. So it neither proves
//   the database you are about to use exists, nor tells you when it doesn't.
//
//   1. cobblr.me's db healthcheck ran `pg_isready -U $POSTGRES_USER` with no
//      -d. The probe passed forever while Postgres logged
//      `FATAL: database "cobblr_pub" does not exist` ~17k times a day: the
//      healthcheck was verifying nothing, and it buried real signal.
//   2. The core-db major-upgrade smoke used it to gate "the seeded cluster is
//      ready", then immediately queried that database. The stock entrypoint
//      runs a TEMPORARY bootstrap server while it is still creating
//      POSTGRES_DB, so pg_isready goes green in a window where the database
//      does not exist yet. It won that race most days and lost it on run 9919,
//      turning main red with a failure that looked nothing like its cause.
//
// THE RULE: every `pg_isready` names a database (`-d <db>` / `--dbname`), so
// the probe is about something real. Waiting for a server with no database in
// mind is legitimate (a bare cluster you are about to create databases in) —
// say so with `-d postgres`, which always exists, or annotate the line with
//   # pg-readiness: ok — <why>
// Better still, gate on a real query (`psql -d <db> -c 'select 1'`), which
// proves the server can actually answer.
//
// Run: npx tsx scripts/lint-pg-readiness.ts

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execSync(
  "git ls-files '*.sh' '*.yml' '*.yaml' '*.ts' '*.mjs' '*.js' 'Dockerfile*' 'docker/*'",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const failures: string[] = [];
let probes = 0;

for (const file of files) {
  if (file === "scripts/lint-pg-readiness.ts") continue;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes("pg_isready")) continue;
  text.split("\n").forEach((line, i) => {
    if (!line.includes("pg_isready")) return;
    // A comment ABOUT the rule is not a use of it.
    const code = line.replace(/^\s*(#|\/\/)\s?.*$/, "");
    if (!code.includes("pg_isready")) return;
    probes++;
    // `-d cobblr_meta`, `-d ${POSTGRES_DB:-…}`, `--dbname=postgres` all count.
    if (/\s(-d|--dbname)(=|\s+)\S/.test(code)) return;
    if (/pg-readiness:\s*ok/.test(line)) return;
    failures.push(`${file}:${i + 1}  ${line.trim().slice(0, 110)}`);
  });
}

if (failures.length) {
  console.error(
    "✗ lint-pg-readiness: pg_isready without a database — it defaults the dbname to the\n" +
      "  USERNAME, so it proves neither that your database exists nor that the server can\n" +
      "  answer for it (a cobblr.me healthcheck passed for months while logging ~17k\n" +
      '  `database "cobblr_pub" does not exist` a day; a CI probe raced the entrypoint\'s\n' +
      "  bootstrap server and turned main red):\n" +
      failures.map((f) => `    ${f}`).join("\n") +
      "\n\n  Add -d <db> (use -d postgres when you genuinely just want the server), or gate on\n" +
      "  a real query: psql -d <db> -tAc 'select 1'. Deliberate exception: end the line with\n" +
      "  # pg-readiness: ok — <why>",
  );
  process.exit(1);
}
console.log(`✓ pg-readiness lint: ${probes} pg_isready probe(s), all naming a database`);
process.exit(0);
