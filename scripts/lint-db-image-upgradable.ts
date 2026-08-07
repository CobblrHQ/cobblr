#!/usr/bin/env tsx
// The database image must stay able to upgrade itself, and every compose file
// must mount it the way that image expects.
//
// Two mistakes here produce the same symptom — a database that refuses to start
// — and both are silent until a deploy:
//
// 1. WRONG MOUNT. Postgres 18+ keeps its cluster in a versioned subdirectory
//    (/var/lib/postgresql/<major>/docker). A compose file still mounting at
//    /var/lib/postgresql/data leaves the server unable to find its data AND
//    unable to pg_upgrade across the mount boundary. This bit staging on the
//    first PG18 start (2026-08-07), and the self-host compose had the same line.
//
// 2. MISSING OLD MAJOR. The image ships the PREVIOUS major's binaries so it can
//    pg_upgrade an existing cluster. Bump the base image without bumping the
//    old-major package and every instance still on the old version stops dead
//    on its next pull — the exact "instances should handle their own updates"
//    property this is here to protect.
//
// 3. LOST SAFETY NETS. The entrypoint must keep its legacy-mount handler (a
//    pre-18 compose file mounts at /var/lib/postgresql/data with the cluster at
//    the mount root — without the handler the upgrade lands on the CONTAINER
//    filesystem and every recreate silently replays it from the stale cluster)
//    and its held-back fallback (an upgrade that cannot proceed must SERVE the
//    old major and signal the admin, never leave a database that will not
//    start). A refactor that drops either reintroduces the wake-up-broken class.
//
//   cd <repo> && npx tsx scripts/lint-db-image-upgradable.ts
//
// Local + CI, free, zero deps.

import { readFileSync } from "node:fs";

const DOCKERFILE = "docker/db.Dockerfile";
const ENTRYPOINT = "docker/db-auto-upgrade.sh";
/** Every compose file that mounts the database's data. */
const COMPOSE = [
  "docker-compose.yml",
  "deploy/docker-compose.prod.yml",
  "deploy/selfhost/standalone/docker-compose.yml",
];

const failures: string[] = [];
const df = readFileSync(DOCKERFILE, "utf8");

// The major this image runs, from its pinned base tag.
const baseMatch = /^FROM\s+postgres:(\d+)-alpine([\d.]*)/m.exec(df);
if (!baseMatch) {
  failures.push(`${DOCKERFILE}: no pinned "FROM postgres:<major>-alpine<version>" line found.`);
} else {
  const major = Number(baseMatch[1]);
  if (!baseMatch[2]) {
    failures.push(
      `${DOCKERFILE}: base tag "postgres:${major}-alpine" is NOT pinned to an Alpine version.\n` +
        `    → pin it (e.g. postgres:${major}-alpine3.24). An unpinned tag can move to an Alpine\n` +
        `      with a different LLVM major and break the pgvector build.`,
    );
  }
  // It must carry the previous major so it can upgrade an existing cluster.
  const prev = major - 1;
  if (!new RegExp(`postgresql${prev}\\b`).test(df)) {
    failures.push(
      `${DOCKERFILE}: runs Postgres ${major} but carries no postgresql${prev} binaries.\n` +
        `    → an instance still on ${prev} cannot upgrade itself and will fail to start\n` +
        `      on its next pull. Add postgresql${prev} (+ pgvector built against it).`,
    );
  }
  if (!/db-auto-upgrade\.sh/.test(df)) {
    failures.push(`${DOCKERFILE}: the auto-upgrade entrypoint is not wired in.`);
  }
}

// The entrypoint's safety nets (see #3 above). Checked as required markers so a
// refactor cannot silently drop them; the docker-build smoke test proves they
// actually work against real clusters.
try {
  const ep = readFileSync(ENTRYPOINT, "utf8");
  for (const [marker, why] of [
    ["migrate_legacy_root", "the legacy-mount handler (pre-18 compose files keep working)"],
    ["hold_back_serve_old", "the held-back fallback (serve the old major instead of dying)"],
    ["COBBLR_DB_MAJOR_UPGRADE", "the operator hold knob"],
    ["cobblr_db_status", "the status row the API turns into an admin alert"],
  ] as const) {
    if (!ep.includes(marker)) {
      failures.push(`${ENTRYPOINT}: "${marker}" is gone — ${why} was dropped.`);
    }
  }
} catch {
  failures.push(`${ENTRYPOINT} is missing — the image cannot upgrade itself.`);
}

for (const file of COMPOSE) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    failures.push(`${file} is missing — update this lint's compose list.`);
    continue;
  }
  src.split("\n").forEach((line, i) => {
    if (!/:\/var\/lib\/postgresql\/data\s*$/.test(line)) return;
    failures.push(
      `${file}:${i + 1} mounts the PRE-18 data path:\n` +
        `    ${line.trim()}\n` +
        `    → mount one level up (…:/var/lib/postgresql). 18+ stores the cluster in a\n` +
        `      versioned subdirectory, and the in-place upgrade needs both sides of it\n` +
        `      inside one mount.`,
    );
  });
}

if (failures.length) {
  console.error(`[lint:db-image-upgradable] ✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:db-image-upgradable] ✓ db image can upgrade itself; every compose mount matches");
