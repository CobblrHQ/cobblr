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

export async function provisionTenantDb(dbName: string): Promise<ProvisionResult> {
  if (!env.SUPERUSER_DATABASE_URL) {
    throw new Error("SUPERUSER_DATABASE_URL must be set to provision tenants");
  }
  assertIdent(dbName);
  const userName = `${dbName}_user`;
  assertIdent(userName);
  const password = randomPassword();

  // Step 1–4: superuser-only operations. Drop the connection as soon
  // as we're done with privileged work.
  const superClient = new Client({ connectionString: env.SUPERUSER_DATABASE_URL });
  await superClient.connect();
  try {
    // Escape single quotes in the password (base64url has none, but
    // future-proof). The user identifier itself is splice-safe per
    // assertIdent above.
    const escapedPassword = password.replace(/'/g, "''");
    await superClient.query(`CREATE DATABASE "${dbName}"`);
    await superClient.query(
      `CREATE USER "${userName}" WITH LOGIN PASSWORD '${escapedPassword}'`,
    );
    await superClient.query(`ALTER DATABASE "${dbName}" OWNER TO "${userName}"`);
  } finally {
    await superClient.end();
  }

  // Step 5: run tenant-base migrations against the new DB, connected
  // as the new tenant user. A small Pool just for this one job —
  // tenant.ts opens the long-lived Pool on first request.
  const url = new URL(env.DATABASE_URL);
  const provisioningPool = new Pool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: dbName,
    user: userName,
    password,
    max: 2,
  });
  let migrationsApplied = 0;
  try {
    const result = await runMigrations({
      pool: provisioningPool,
      directory: tenantBaseDir,
      scope: `tenant ${dbName}`,
    });
    migrationsApplied = result.applied.length;
  } finally {
    await provisioningPool.end();
  }

  const credentialsEncrypted = encryptCreds(JSON.stringify({ user: userName, password }));
  return { credentialsEncrypted, migrationsApplied };
}
