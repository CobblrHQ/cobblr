// The instance's VAPID key pair for Web Push (#5267).
//
// PERMANENT RECONCILE — every boot makes sure the pair exists: a box that has
// none (a new install, or one from before push) makes it, one that has it
// keeps it. The pair is never replaced on its own: every browser subscription
// is bound to the public key, so a new pair would silently orphan every
// device. The one exception is a pair this server cannot open, which signs
// nothing and has orphaned them already. An operator's pair (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY_FILE) wins
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

/** The stored private key, or null when this server's credential key cannot
 *  open it (a database moved between installs, or a changed
 *  TENANT_CREDS_ENCRYPTION_KEY): nothing can be signed with it then. */
async function openPrivateKey(enc: string): Promise<string | null> {
  const { decryptCreds } = await import("../db/crypto.js");
  try {
    return decryptCreds(enc);
  } catch {
    // pass-catch: an unopenable key is the answer, said by the boot pass's log and the routes' reason
    return null;
  }
}

/** Make or adopt the pair; cheap when it is there already. A stored pair this
 *  server cannot open is replaced: it can sign nothing, so every device under
 *  it is already unreachable and has to turn push on again either way. */
export async function ensureVapidKeys(): Promise<void> {
  // Lazily: the credential key is read when this runs, not when a file that
  // only sends pushes is imported (a test that never boots the api).
  const { encryptCreds } = await import("../db/crypto.js");
  const given = operatorKeys();
  const row = await meta.selectFrom("push_vapid_keys").select(["public_key", "private_key_enc", "source"]).where("id", "=", 1).executeTakeFirst();
  const unreadable = !!row && (await openPrivateKey(row.private_key_enc)) === null;
  if (unreadable) console.error("[push] this server cannot open its stored Web Push key (made under another credential key); replacing it, so devices need to turn push on again");
  const have = unreadable ? undefined : row;
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
  const values = { id: 1, public_key: made.publicKey, private_key_enc: encryptCreds(made.privateKey), source: "generated" } as const;
  // ON CONFLICT DO NOTHING: two api processes booting together make one pair.
  // Over an unreadable pair, only the one this boot read is replaced.
  await (unreadable
    ? meta.updateTable("push_vapid_keys").set(values).where("id", "=", 1).where("private_key_enc", "=", row.private_key_enc).execute()
    : meta.insertInto("push_vapid_keys").values(values).onConflict((oc) => oc.column("id").doNothing()).execute());
  cached = null;
  console.log("[push] made this instance's Web Push (VAPID) key pair");
}

export type VapidKeyState = { keys: VapidKeys; unavailable: null } | { keys: null; unavailable: string };

/** The pair to sign with, or why there is none: said to the person who tries
 *  to turn push on, never a 500. */
export async function vapidKeyState(): Promise<VapidKeyState> {
  if (cached) return { keys: cached, unavailable: null };
  const row = await meta.selectFrom("push_vapid_keys").select(["public_key", "private_key_enc"]).where("id", "=", 1).executeTakeFirst();
  if (!row) return { keys: null, unavailable: "This server has not made its notification key yet." };
  const privateKey = await openPrivateKey(row.private_key_enc);
  if (privateKey === null) return { keys: null, unavailable: "This server can't open its notification key, so it can't send notifications. Restarting the server makes a new one." };
  cached = { publicKey: row.public_key, privateKey };
  return { keys: cached, unavailable: null };
}

/** The pair to sign with, or null when there is none this server can use. */
export async function vapidKeys(): Promise<VapidKeys | null> {
  return (await vapidKeyState()).keys;
}

/** Who the push services may contact about this instance's pushes. */
export function vapidSubject(): string {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  const base = publicBaseUrl();
  return base?.startsWith("https://") ? base : "https://cobblr.xyz";
}
