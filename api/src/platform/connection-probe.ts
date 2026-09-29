// The probe that decides whether a personal connection is ready (#2895): the
// provider's cheapest call, no workspace data, and the verdict becomes the
// connection's verification.
//
// A save that changed only the label or the routing has nothing new to probe.
// The Test button always does: a bridge holds no key at all (it is reached
// through its owner's edge agent), so "no credentials, nothing to test" read
// every bridge as Unverified forever, however well it answered.

import { verificationOf, type ConnectionVerification } from "@cobblr/platform-contract/connection-verification";
import * as aiImpl from "./ai.js";
import { meta } from "../db/meta.js";
import { onBridgeOnline } from "./edge.js";
import { storedUserCredentials, updateUserCredential, usesEdge } from "./user-credentials.js";

/** Does this save carry a credential worth probing? */
export function carriesCredentials(credentials: Record<string, unknown> | undefined): boolean {
  return !!credentials && Object.values(credentials).some((v) => typeof v === "string" && v.trim());
}

/** Probe a provider with these credentials, as this user. A provider with no
 *  probe is "unverified" by construction and says so. */
export async function probeConnection(
  providerId: string,
  credentials: Record<string, unknown>,
  userId: string,
): Promise<ConnectionVerification | null> {
  const def = aiImpl.getProvider(providerId);
  if (!def) return null;
  if (!def.testConnection) return { state: "unverified", at: new Date().toISOString(), message: "This provider has no way to be tested from here." };
  const model = typeof credentials.model === "string" && credentials.model.trim() ? credentials.model.trim() : null;
  const started = Date.now();
  try {
    const probe = await def.testConnection({ ...credentials, __connection_user_id: userId });
    return verificationOf(probe, model, new Date(), Date.now() - started);
  } catch (err) {
    return verificationOf({ ok: false, reason: "unknown", error: (err as Error)?.message }, null, new Date(), Date.now() - started);
  }
}

/** Test one stored connection and keep the verdict on it. */
export async function testStoredConnection(userId: string, id: string): Promise<ConnectionVerification | null> {
  const stored = await storedUserCredentials(userId, id);
  if (!stored) return null;
  const verification = (await probeConnection(stored.provider_id, stored.credentials, userId)) ?? {
    state: "unverified" as const,
    at: new Date().toISOString(),
    message: "This provider is not available on this server.",
  };
  await updateUserCredential(userId, id, { verification });
  return verification;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lastReverify = new Map<string, number>();
/** A bridge that flaps must not probe on every reconnect. */
const REVERIFY_EVERY_MS = 60_000;
/** Let the bridge's first poll park before the probe queues work for it. */
const SETTLE_MS = 1_500;

/** Re-test every connection of this person's that rides their edge agent, now
 *  that it is back. The channel key of a personal bridge is its owner's user
 *  id (a named one is `<user id>::<name>`). */
export async function reverifyBridgeConnections(
  channelKey: string,
  opts: { settleMs?: number; test?: typeof testStoredConnection } = {},
): Promise<string[]> {
  const userId = channelKey.split("::")[0] ?? "";
  if (!UUID_RE.test(userId)) return [];
  const now = Date.now();
  if (now - (lastReverify.get(userId) ?? 0) < REVERIFY_EVERY_MS) return [];
  lastReverify.set(userId, now);
  const rows = await meta
    .selectFrom("user_credentials")
    .select(["id", "provider_id", "credentials_encrypted"])
    .where("user_id", "=", userId)
    .where("kind", "=", "ai-provider")
    .execute();
  const riding = rows.filter((r) => usesEdge(r.provider_id, r.credentials_encrypted));
  if (!riding.length) return [];
  await new Promise((r) => setTimeout(r, opts.settleMs ?? SETTLE_MS));
  const done: string[] = [];
  for (const r of riding) {
    try {
      const v = await (opts.test ?? testStoredConnection)(userId, r.id);
      if (v) done.push(r.id);
      console.log(`[connections] bridge back online: re-tested ${r.id.slice(0, 8)}… → ${v?.state ?? "gone"}`);
    } catch (err) {
      console.warn(`[connections] re-test of ${r.id.slice(0, 8)}… failed: ${(err as Error).message}`);
    }
  }
  return done;
}

/** Wire the re-test to the bridge registry. Called once at boot. */
export function reverifyWhenBridgesReturn(): void {
  onBridgeOnline((key) => {
    void reverifyBridgeConnections(key).catch((err) => console.warn(`[connections] re-verify on ${key.slice(0, 8)}… failed: ${(err as Error).message}`));
  });
}

/** Test-only: forget the per-person throttle. */
export function resetReverifyThrottle(): void {
  lastReverify.clear();
}
