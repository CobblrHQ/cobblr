// A sandbox nobody holds yet: built (and, from the pool, seeded) ahead of the
// visitor it will be handed to. Nothing happens to it until then. An
// automation that fired on the seed's own records while it waited made five
// shopping-list lines at 20:45 in a sandbox handed over hours later, and they
// read as the visitor's (#4217). So no wire fires and no periodic pass visits
// one; the sandbox arrives exactly as the seed left it.
//
// Awaiting is `sandbox and trial_expires_at is null`: the pool's claim and the
// hand-over both set the expiry, and it is never cleared again. So a workspace
// seen settled stays settled, and only the rare awaiting one is read twice.
import { meta } from "../db/meta.js";

const settled = new Set<string>();

export async function sandboxAwaitingVisitor(orgId: string): Promise<boolean> {
  if (settled.has(orgId)) return false;
  const row = await meta.selectFrom("orgs").select(["sandbox", "trial_expires_at"]).where("id", "=", orgId).executeTakeFirst();
  const awaiting = !!row && row.sandbox === true && row.trial_expires_at === null;
  if (!awaiting) settled.add(orgId);
  return awaiting;
}
