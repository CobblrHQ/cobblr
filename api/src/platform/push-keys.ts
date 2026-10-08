// The instance's VAPID key pair for Web Push (#5267).
//
// PERMANENT RECONCILE — every boot makes sure the pair exists: a box that has
// none (a new install, or one from before push) makes it, one that has it
// keeps it. The pair is never replaced on its own: every browser subscription
// is bound to the public key, so a new pair would silently orphan every
// device. An operator's pair (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY_FILE) wins
// over a generated one and is recorded as theirs.
// BORN WITH: nothing (instance-wide, one pair per instance, not per workspace)
import { readFileSync } from "node:fs";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { generateVapidKeys, vapidKeysMatch, type VapidKeys } from "./web-push.js";

let cached: VapidKeys | null = null;

/** The operator's pair, when the environment gives one. A key that does not
 *  match its public half refuses loudly: a push signed by the wrong key is
 *  refused by every push service, which would look like push "not working". */
function operatorKeys(): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY && !env.VAPID_PRIVATE_KEY_FILE) return null;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY_FILE) {
    throw new Error("Web Push: set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY_FILE, or neither (the instance then makes its own pair)");
  }
  const keys = { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: readFileSync(env.VAPID_PRIVATE_KEY_FILE, "utf8").trim() };
  if (!vapidKeysMatch(keys)) throw new Error("Web Push: the private key in VAPID_PRIVATE_KEY_FILE is not the one VAPID_PUBLIC_KEY was made from");
  return keys;
}

/** Make or adopt the pair; cheap when it is there already. */
export async function ensureVapidKeys(): Promise<void> {
  // Lazily: the credential key is read when this runs, not when a file that
  // only sends pushes is imported (a test that never boots the api).
  const { encryptCreds } = await import("../db/crypto.js");
  const given = operatorKeys();
  const have = await meta.selectFrom("push_vapid_keys").select(["public_key", "source"]).where("id", "=", 1).executeTakeFirst();
  if (given) {
    if (have?.public_key === given.publicKey) return;
    // The operator's pair replaces a generated one: that is a decision they
    // made, and a device subscribed under the old key subscribes again.
    await meta
      .insertInto("push_vapid_keys")
      .values({ id: 1, public_key: given.publicKey, private_key_enc: encryptCreds(given.privateKey), source: "operator" })
      .onConflict((oc) => oc.column("id").doUpdateSet({ public_key: given.publicKey, private_key_enc: encryptCreds(given.privateKey), source: "operator" }))
      .execute();
    cached = null;
    if (have) console.log("[push] VAPID keys replaced by the operator's; devices subscribed under the old key need to turn push on again");
    return;
  }
  if (have) return;
  const made = generateVapidKeys();
  // ON CONFLICT DO NOTHING: two api processes booting together make one pair.
  await meta
    .insertInto("push_vapid_keys")
    .values({ id: 1, public_key: made.publicKey, private_key_enc: encryptCreds(made.privateKey), source: "generated" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  console.log("[push] made this instance's Web Push (VAPID) key pair");
}

/** The pair to sign with, or null when there is none yet. */
export async function vapidKeys(): Promise<VapidKeys | null> {
  if (cached) return cached;
  const row = await meta.selectFrom("push_vapid_keys").select(["public_key", "private_key_enc"]).where("id", "=", 1).executeTakeFirst();
  if (!row) return null;
  const { decryptCreds } = await import("../db/crypto.js");
  cached = { publicKey: row.public_key, privateKey: decryptCreds(row.private_key_enc) };
  return cached;
}

/** Who the push services may contact about this instance's pushes. */
export function vapidSubject(): string {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  const base = publicBaseUrl();
  return base?.startsWith("https://") ? base : "https://cobblr.xyz";
}
