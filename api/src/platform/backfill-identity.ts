// PERMANENT RECONCILE — not a one-shot heal. Links this surface's local users to their
// global identities (Slice 3). Runs every boot while central identity is wired, because
// new local users keep appearing during the transition (local signup still works) and
// each needs linking. No-op unless IDENTITY_URL is set.
//
// Meta-only (no tenant pools opened), idempotent (only unlinked users), and resilient
// (a failed batch or a single link never aborts the rest). It PUSHES each user's existing
// (bcrypt) password_hash so the migrated account can log in centrally unchanged; the
// identity service merges duplicates by email (try + cobblr.me under one email → one id).

import { meta } from "../db/meta.js";
import { identityEnabled, backfillToIdentity, type BackfillUser } from "../auth/identity-client.js";

const BATCH = 500;

export async function backfillIdentityLinks(): Promise<{ linked: number }> {
  if (!identityEnabled()) return { linked: 0 };

  const rows = await meta
    .selectFrom("users")
    .select(["id", "email", "password_hash", "display_name"])
    .where("identity_id", "is", null)
    .execute();
  if (rows.length === 0) return { linked: 0 };

  let linked = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const users: BackfillUser[] = chunk.map((u) => ({
      local_user_id: u.id,
      email: u.email,
      password_hash: u.password_hash,
      display_name: u.display_name,
    }));
    let links: Record<string, string>;
    try {
      links = await backfillToIdentity(users);
    } catch (e) {
      console.error(`[reconcile] identity backfill batch failed: ${(e as Error).message}`);
      continue; // leave these unlinked; next boot retries
    }
    for (const [localId, identityId] of Object.entries(links)) {
      try {
        // Re-check identity_id IS NULL so a concurrent write never gets clobbered.
        const r = await meta
          .updateTable("users")
          .set({ identity_id: identityId })
          .where("id", "=", localId)
          .where("identity_id", "is", null)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) > 0) linked++;
      } catch (e) {
        console.error(`[reconcile] identity link ${localId} failed: ${(e as Error).message}`);
      }
    }
  }
  if (linked > 0) console.log(`[reconcile] identity: linked ${linked} local user(s) to a global identity`);
  return { linked };
}
