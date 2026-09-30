// Keeping a sandbox with an address that already keeps a trial here.
//
// "Give me two weeks" with such an address used to answer "That email already
// has an account. Sign in with it instead." and nothing else: no link, no way
// to keep this sandbox too (#4217). Now the sandbox joins that account as
// another workspace, each on its own two-week clock, once the address says
// yes. Typing an address proves nothing about owning it, so nothing attaches
// until the link sent to it is opened; until then the sandbox is held.
//
// At most KEPT_TRIALS_PER_ADDRESS workspaces per address: past it, the answer
// says so and points at moving one to a real account.
import { createHash, randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { sendAuthEmail } from "./hosted-seams.js";
import { sandboxDecisionMs } from "./try-sandbox.js";
import { trialLedger } from "./trial-ledger.js";

export const KEPT_TRIALS_PER_ADDRESS = 3;
/** However little of its hour was left, a sandbox waiting on a join is held
 *  at least this long, so an inbox that takes a while is not a lost sandbox. */
const MIN_JOIN_HOLD_MS = 24 * 3_600_000;

const hash = (plain: string) => createHash("sha256").update(plain).digest("hex");

export interface KeptWorkspace {
  org_id: string;
  slug: string;
  name: string;
  expires_at: Date;
}

/** The trials this account keeps here, still running, oldest first. */
export async function keptWorkspacesOf(userId: string, now: Date = new Date()): Promise<KeptWorkspace[]> {
  const rows = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id as org_id", "o.slug", "o.name", "o.trial_expires_at"])
    .where("m.user_id", "=", userId)
    .where("o.sandbox", "=", false)
    .where("o.trial_expires_at", ">", now)
    .orderBy("o.created_at")
    .execute();
  return rows.map((r) => ({ org_id: r.org_id, slug: r.slug, name: r.name, expires_at: r.trial_expires_at! }));
}

/** "Wine, 4 items": a kept workspace as its owner would recognise it. */
async function workspaceLine(orgId: string, name: string): Promise<string> {
  const ledger = await trialLedger(orgId).catch(() => null);
  const set = ledger ? [...new Set([...ledger.bundles.map((b) => b.name), ...ledger.instances.map((i) => i.display_name)])] : [];
  const items = ledger ? ledger.records.reduce((n, r) => n + r.ids.length, 0) : 0;
  const label = set.length ? set.join(" and ") : name;
  return items ? `${label}, ${items} item${items === 1 ? "" : "s"}` : label;
}

export type JoinRequest =
  | { ok: true; emailed: boolean; heldUntil: Date; devToken?: string }
  | { ok: false; reason: "keep_limit"; kept: string[] };

/** Ask the address to take this sandbox in. Holds the sandbox; attaches nothing. */
export async function requestKeepJoin(o: {
  orgId: string;
  guestUserId: string;
  accountUserId: string;
  email: string;
  absBase: string;
  now?: number;
}): Promise<JoinRequest> {
  const now = o.now ?? Date.now();
  const kept = await keptWorkspacesOf(o.accountUserId, new Date(now));
  if (kept.length >= KEPT_TRIALS_PER_ADDRESS) {
    return { ok: false, reason: "keep_limit", kept: await Promise.all(kept.map((k) => workspaceLine(k.org_id, k.name))) };
  }

  const heldUntil = new Date(now + Math.max(MIN_JOIN_HOLD_MS, sandboxDecisionMs()));
  await meta
    .updateTable("orgs")
    .set({ trial_expires_at: heldUntil })
    .where("id", "=", o.orgId)
    .where("sandbox", "=", true)
    .execute();

  const plain = randomBytes(32).toString("base64url");
  await meta
    .insertInto("try_keep_joins")
    .values({ org_id: o.orgId, account_user_id: o.accountUserId, guest_user_id: o.guestUserId, token_hash: hash(plain), expires_at: heldUntil })
    .execute();

  const lines = await Promise.all(kept.map(async (k) => `  ${await workspaceLine(k.org_id, k.name)}: ${o.absBase}/w/${k.slug}`));
  const thisOne = await workspaceLine(o.orgId, "this sandbox");
  const sent = await sendAuthEmail({
    to: o.email,
    subject: "Keep another Cobblr sandbox",
    text:
      `Someone asked to keep a Cobblr sandbox (${thisOne}) with this address, which already keeps ` +
      `${kept.length === 1 ? "a trial" : `${kept.length} trials`} here:\n\n${lines.join("\n")}\n\n` +
      `To add it beside ${kept.length === 1 ? "that one" : "them"} as another workspace, for ${env.TRY_SANDBOX_TRIAL_DAYS} days of its own:\n\n` +
      `${o.absBase}/try/join/${plain}\n\n` +
      `The link signs you in. Nothing is added until you open it, and the sandbox waits until then. ` +
      `If this was not you, ignore this email and the sandbox is deleted as planned.`,
    kind: "magic_link",
  }).catch(() => false);
  return { ok: true, emailed: sent, heldUntil, devToken: !sent && env.NODE_ENV !== "production" ? plain : undefined };
}

export type JoinResult =
  | { ok: true; accountUserId: string; slug: string; expiresAt: Date }
  | { ok: false; reason: "unknown" | "used" | "expired" | "keep_limit" | "gone" };

/** The address said yes: the sandbox becomes another of its workspaces. */
export async function consumeKeepJoin(plain: string, now: number = Date.now()): Promise<JoinResult> {
  if (!plain || plain.length > 200) return { ok: false, reason: "unknown" };
  const row = await meta.selectFrom("try_keep_joins").selectAll().where("token_hash", "=", hash(plain)).executeTakeFirst();
  if (!row) return { ok: false, reason: "unknown" };
  if (row.consumed_at) return { ok: false, reason: "used" };
  if (row.expires_at.getTime() <= now) return { ok: false, reason: "expired" };
  const org = await meta.selectFrom("orgs").select(["slug", "sandbox"]).where("id", "=", row.org_id).executeTakeFirst();
  if (!org?.sandbox) return { ok: false, reason: "gone" };
  if ((await keptWorkspacesOf(row.account_user_id, new Date(now))).length >= KEPT_TRIALS_PER_ADDRESS) return { ok: false, reason: "keep_limit" };

  const expiresAt = new Date(now + env.TRY_SANDBOX_TRIAL_DAYS * 86_400_000);
  await meta.transaction().execute(async (trx) => {
    await trx.updateTable("try_keep_joins").set({ consumed_at: new Date(now) }).where("id", "=", row.id).execute();
    await trx
      .insertInto("org_memberships")
      .values({ user_id: row.account_user_id, org_id: row.org_id, role: "owner" })
      .onConflict((oc) => oc.columns(["user_id", "org_id"]).doUpdateSet({ role: "owner" }))
      .execute();
    // The guest was this sandbox's only person, and the address now is.
    await trx.deleteFrom("org_memberships").where("org_id", "=", row.org_id).where("user_id", "=", row.guest_user_id).execute();
    await trx.updateTable("try_sandbox_tokens").set({ revoked_at: new Date(now) }).where("org_id", "=", row.org_id).where("revoked_at", "is", null).execute();
    await trx.updateTable("orgs").set({ sandbox: false, trial_expires_at: expiresAt, name: "My workspace" }).where("id", "=", row.org_id).where("name", "=", "Sandbox").execute();
    await trx.updateTable("orgs").set({ sandbox: false, trial_expires_at: expiresAt }).where("id", "=", row.org_id).execute();
  });
  return { ok: true, accountUserId: row.account_user_id, slug: org.slug, expiresAt };
}
