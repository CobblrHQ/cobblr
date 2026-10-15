import { signupFreshOrg, type TestSession } from "./helpers.js";
import { meta } from "../src/db/meta.js";
import { handOverSandbox } from "../src/platform/try-sandbox.js";

/** Counting needs a handed-over workspace, not the public door's household seed. */
export async function ledgerSandbox(): Promise<TestSession> {
  const session = await signupFreshOrg("ledger-count");
  await meta.updateTable("orgs").set({ sandbox: true }).where("id", "=", session.orgId).execute();
  await handOverSandbox(
    { orgId: session.orgId, userId: session.userId, slug: session.slug },
    Date.now(),
    { quiet: true },
  );
  return session;
}
