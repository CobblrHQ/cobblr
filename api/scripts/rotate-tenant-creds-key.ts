// Rotate TENANT_CREDS_ENCRYPTION_KEY (2026-07 audit F8 follow-up: "losing the
// key bricks every tenant DB" had no rotation story — the mitigation was
// literally 'paper in a lockbox').
//
// What it does: re-encrypts every orgs.db_credentials_encrypted payload from
// the CURRENT key to a NEW key, verifying each decrypt+re-encrypt round-trip
// before writing. The api KEEPS RUNNING on the old key during the sweep (rows
// it reads still decrypt — untouched rows with the old key, rotated rows only
// after you flip the env and restart... so the correct order is: STOP the api
// first). Full procedure:
//
//   1. Stop the api (rotation with a live writer risks a torn state):
//        docker compose stop api
//   2. Run the sweep (both keys supplied; DATABASE_URL as usual):
//        cd api && DATABASE_URL=... \
//          TENANT_CREDS_ENCRYPTION_KEY="<current key>" \
//          NEW_TENANT_CREDS_ENCRYPTION_KEY="<new key>" \
//          npx tsx scripts/rotate-tenant-creds-key.ts
//      Add --dry-run to verify every row decrypts without writing anything.
//   3. Put the NEW key in .env as TENANT_CREDS_ENCRYPTION_KEY (save the old
//      one until you've verified boot).
//   4. docker compose up -d api  →  healthz green, open a workspace.
//   5. Retire the old key from wherever it lived. Print the new one to paper.
//
// Safety properties: idempotent-safe to re-run with the same pair (rows already
// on the new key fail old-key decrypt and are then tried with the new key — if
// that succeeds they're counted as `already_rotated` and skipped); any row that
// decrypts with NEITHER key aborts the whole run before a single write (that's
// a mixed-key state you must resolve by hand, not paper over).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { Pool } from "pg";
import { guardPoolClients } from "../src/db/client-error-guard.js";

const SALT = "cobblr-tenant-creds-v1"; // must match api/src/db/crypto.ts

function keyFrom(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, 32);
}
function decryptWith(key: Buffer, payload: string): string {
  const [ivHex, tagHex, ctHex] = payload.split(".") as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${enc.toString("hex")}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const oldPass = process.env.TENANT_CREDS_ENCRYPTION_KEY;
  const newPass = process.env.NEW_TENANT_CREDS_ENCRYPTION_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!oldPass || !newPass || !dbUrl) {
    console.error(
      "Required env: DATABASE_URL, TENANT_CREDS_ENCRYPTION_KEY (current), NEW_TENANT_CREDS_ENCRYPTION_KEY (target).",
    );
    process.exit(2);
  }
  if (oldPass === newPass) {
    console.error("Old and new keys are identical — nothing to rotate.");
    process.exit(2);
  }
  const oldKey = keyFrom(oldPass);
  const newKey = keyFrom(newPass);

  const pool = new Pool({ connectionString: dbUrl });
  // Same reason as the restore script, and it matters more here: this rewrites
  // db_credentials_encrypted for every org. Dying on an unhandled pool 'error'
  // mid-rotation gives a raw stack instead of a legible failure, on the one
  // operation where knowing exactly where it stopped is the whole ballgame.
  // (Phase 1 verifies every row before any write, so a failure here is safe —
  // but it must be READABLE.)
  guardPoolClients(pool, "rotate-creds-key");
  pool.on("error", (err) => {
    console.error("[rotate-key] database connection error:", (err as Error).message);
  });
  const { rows } = await pool.query<{ id: string; slug: string; db_credentials_encrypted: string | null }>(
    "select id, slug, db_credentials_encrypted from orgs order by created_at",
  );

  // Phase 1 — verify EVERY row before touching ANY row.
  const plan: Array<{ id: string; slug: string; plaintext: string }> = [];
  let alreadyRotated = 0;
  let empty = 0;
  for (const r of rows) {
    if (!r.db_credentials_encrypted) {
      empty++;
      continue;
    }
    try {
      plan.push({ id: r.id, slug: r.slug, plaintext: decryptWith(oldKey, r.db_credentials_encrypted) });
    } catch {
      try {
        decryptWith(newKey, r.db_credentials_encrypted);
        alreadyRotated++; // re-run after a partial flip — fine, skip
      } catch {
        console.error(
          `ABORT before any write: org ${r.slug} (${r.id}) decrypts with NEITHER key. ` +
            `Mixed/unknown key state — resolve by hand first.`,
        );
        await pool.end();
        process.exit(1);
      }
    }
  }
  console.log(
    `${rows.length} org(s): ${plan.length} to rotate, ${alreadyRotated} already on the new key, ${empty} with no stored creds.` +
      (dryRun ? " (dry-run: verified decrypt only, writing nothing)" : ""),
  );
  if (dryRun || plan.length === 0) {
    await pool.end();
    return;
  }

  // Phase 2 — one transaction; verified round-trip per row.
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const p of plan) {
      const rewrapped = encryptWith(newKey, p.plaintext);
      if (decryptWith(newKey, rewrapped) !== p.plaintext) {
        throw new Error(`round-trip verification failed for org ${p.slug}`);
      }
      await client.query("update orgs set db_credentials_encrypted = $1 where id = $2", [rewrapped, p.id]);
    }
    await client.query("commit");
    console.log(`Rotated ${plan.length} org(s). Now set TENANT_CREDS_ENCRYPTION_KEY to the NEW key and start the api.`);
  } catch (err) {
    await client.query("rollback");
    console.error("Rolled back — nothing changed:", (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
