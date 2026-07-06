// Tenant DB provisioning. Run once per org at signup time:
//
//   1. Connect as the Postgres superuser
//   2. CREATE DATABASE <db_name>
//   3. CREATE USER <db_name>_user with a random password
//   4. ALTER DATABASE <db_name> OWNER TO <user>
//        — gives the tenant user full rights to its own DB,
//          including CREATE in the public schema (Postgres 15+
//          revoked default public privileges).
//   5. Reconnect AS the tenant user and run tenant-base migrations
//
// Encrypted credentials are returned so the caller can persist them
// in orgs.db_credentials_encrypted.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { env } from "../env.js";
import { encryptCreds } from "./crypto.js";
import { runMigrations } from "./migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/db/provision.js → ../../migrations/tenant-base
// src/db/provision.ts → ../../migrations/tenant-base
const tenantBaseDir = resolve(__dirname, "..", "..", "migrations", "tenant-base");

export interface ProvisionResult {
  /** Encrypted JSON of { user, password } — store in orgs.db_credentials_encrypted. */
  credentialsEncrypted: string;
  /** How many migrations were just applied. */
  migrationsApplied: number;
}

/** Postgres identifiers in CREATE statements can't be parameterised,
 *  so validate the inputs against a strict pattern before splicing
 *  them in. The db_name and user_name we generate already match this
 *  pattern; the assertion is belt-and-suspenders against any future
 *  caller passing something exotic. */
function assertIdent(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to splice unsafe identifier: ${name}`);
  }
}

function randomPassword(): string {
  // 32 random bytes → 43 base64url chars, no padding, no escape headaches.
  return randomBytes(32).toString("base64url");
}

// SQLSTATEs that mean "transient contention — safe to retry after a beat", NOT
// "this org's provisioning is fundamentally broken". The one that made CI flake:
//   55006 object_in_use  — `CREATE DATABASE` throws "source database 'template1'
//                          is being accessed by other users" when a concurrent
//                          `DROP DATABASE` (a parallel test fork's teardown) is
//                          mid-flight on the shared catalog. Load-dependent,
//                          intermittent, no app stack trace — the classic flake.
// Plus the neighbours that show up under the same 8-fork load:
//   53300 too_many_connections · 57P03 cannot_connect_now
//   40P01 deadlock_detected    · 40001 serialization_failure
//   08xxx/57P01 connection dropped mid-statement.
const TRANSIENT_PROVISION_CODES = new Set([
  "55006", "53300", "57P03", "40P01", "40001", "08006", "08003", "08000", "57P01",
]);

function isTransientProvisionError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code && TRANSIENT_PROVISION_CODES.has(code)) return true;
  // Some drivers surface these as bare connection errors with no SQLSTATE.
  const msg = (err as Error | undefined)?.message ?? "";
  return /being accessed by other users|too many clients|connection.*(reset|closed|terminat)/i.test(msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One provisioning attempt: create the DB + tenant user, then run tenant-base
 *  migrations as that user. `reset` (retries only) drops any partial state from a
 *  prior failed attempt first, so a retry is a clean slate whether the previous
 *  attempt died at CREATE DATABASE, CREATE USER, or mid-migration. */
async function provisionOnce(
  dbName: string,
  userName: string,
  password: string,
  reset: boolean,
): Promise<number> {
  const escapedPassword = password.replace(/'/g, "''");
  // Steps 1–4: superuser-only operations. Drop the connection as soon as the
  // privileged work is done.
  const superClient = new Client({ connectionString: env.SUPERUSER_DATABASE_URL });
  await superClient.connect();
  try {
    if (reset) {
      // Wipe a half-provisioned leftover so CREATE below doesn't hit "already
      // exists". No-op on a first attempt (this branch only runs on retry).
      await superClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await superClient.query(`DROP USER IF EXISTS "${userName}"`);
    }
    // Escape single quotes in the password (base64url has none, but
    // future-proof). The user identifier itself is splice-safe per assertIdent.
    await superClient.query(`CREATE DATABASE "${dbName}"`);
    await superClient.query(
      `CREATE USER "${userName}" WITH LOGIN PASSWORD '${escapedPassword}'`,
    );
    await superClient.query(`ALTER DATABASE "${dbName}" OWNER TO "${userName}"`);
  } finally {
    await superClient.end();
  }

  // Step 5: run tenant-base migrations against the new DB, connected as the new
  // tenant user. A small Pool just for this one job — tenant.ts opens the
  // long-lived Pool on first request.
  const url = new URL(env.DATABASE_URL);
  const provisioningPool = new Pool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: dbName,
    user: userName,
    password,
    max: 2,
  });
  try {
    const result = await runMigrations({
      pool: provisioningPool,
      directory: tenantBaseDir,
      scope: `tenant ${dbName}`,
    });
    return result.applied.length;
  } finally {
    await provisioningPool.end();
  }
}

export async function provisionTenantDb(dbName: string): Promise<ProvisionResult> {
  if (!env.SUPERUSER_DATABASE_URL) {
    throw new Error("SUPERUSER_DATABASE_URL must be set to provision tenants");
  }
  assertIdent(dbName);
  const userName = `${dbName}_user`;
  assertIdent(userName);
  const password = randomPassword();

  // Retry the WHOLE create+migrate on transient catalog/connection contention.
  // Before this, a single `CREATE DATABASE` collision with a concurrent
  // `DROP DATABASE` threw, the caller (provisionOrgForUser) SWALLOWED it, signup
  // still returned 201 + a token, and the org was left db_credentials_encrypted
  // NULL — so the next `GET /orgs/:slug/modules` 503'd (`tenant_unprovisioned`).
  // That was the "random victim, clears on re-run" CI flake (issue #765). A
  // bounded retry absorbs the momentary contention here — and hardens real prod
  // signups against the same catalog race — instead of shipping a broken org.
  const MAX_ATTEMPTS = 5;
  let migrationsApplied = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      migrationsApplied = await provisionOnce(dbName, userName, password, attempt > 1);
      break;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isTransientProvisionError(err)) {
        const code = (err as { code?: string }).code ?? "conn";
        const first = ((err as Error).message ?? "").split("\n")[0];
        console.warn(
          `[provision] ${dbName} attempt ${attempt}/${MAX_ATTEMPTS} transient ${code}: ${first} — retrying`,
        );
        await sleep(attempt * 200 + Math.floor(Math.random() * 150));
        continue;
      }
      throw err;
    }
  }

  const credentialsEncrypted = encryptCreds(JSON.stringify({ user: userName, password }));
  return { credentialsEncrypted, migrationsApplied };
}
