// Approving a tablet as a station, without signing in on it (#4640).
//
// A tablet opens a station address (`/station/<workspace>/<address>`) and asks
// to be approved: it gets a short code to show and a poll key it keeps. An
// owner or admin of the workspace types the code (or scans the tablet's QR)
// on their own screen. The tablet's next poll claims a token that reaches
// only that station: scope `station:<address>`, held to the workspace, able
// to change records and never settings. No password is typed on a shared
// screen, and no token is stored here: it is minted when the tablet claims
// it, once. Revoking it (Configuration → Devices) ends the tablet's access.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { mintTokenString } from "../auth/api-tokens.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import {
  STATION_CODE_ALPHABET,
  STATION_CODE_LENGTH,
  STATION_REQUEST_TTL_MS,
  isStationAddress,
  normalizeStationCode,
  stationAddressOfScope,
  stationDeviceName,
  stationLabelOf,
  stationScope,
  stationQrName,
  stationQrScope,
} from "@cobblr/platform-contract/station-screen";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The source every station token carries, so the list and the revoke find
 *  them and nothing else. */
export const STATION_TOKEN_SOURCE = "station approval";

export type StationRequest = { request_id: string; poll_key: string; code: string; expires_at: string };

/** A tablet asks to become the station at `address` of the workspace `slug`.
 *  Whether the workspace exists is not said here: the code is only worth
 *  anything to someone signed in to it. */
export async function requestStationApproval(p: { slug: string; address: string }): Promise<StationRequest | null> {
  if (!isStationAddress(p.address) || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(p.slug)) return null;
  await meta.deleteFrom("station_device_requests").where("expires_at", "<", new Date()).execute();
  const pollKey = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + STATION_REQUEST_TTL_MS);
  // A clash of two live codes is about one in 9e8 per pair; the unique index
  // refuses it, and a second draw goes through.
  for (let attempt = 0; attempt < 3; attempt++) {
    let code = "";
    for (let i = 0; i < STATION_CODE_LENGTH; i++) code += STATION_CODE_ALPHABET[randomInt(STATION_CODE_ALPHABET.length)];
    const row = await meta
      .insertInto("station_device_requests")
      .values({ code_hash: sha(code), poll_hash: sha(pollKey), org_slug: p.slug, address: p.address, expires_at: expires })
      .onConflict((oc) => oc.column("code_hash").doNothing())
      .returning(["id"])
      .executeTakeFirst();
    if (row) return { request_id: row.id, poll_key: pollKey, code, expires_at: expires.toISOString() };
  }
  return null;
}

export type ApproveResult =
  | { ok: true; address: string; label: string }
  | { ok: false; reason: "unknown" | "other_workspace" };

/** An owner or admin approves the tablet showing `code`. The approval names
 *  the person and the workspace; the token is minted at the claim. */
export async function approveStation(p: { orgId: string; orgSlug: string; userId: string; code: unknown; label?: string | null }): Promise<ApproveResult> {
  const code = normalizeStationCode(p.code);
  if (!code) return { ok: false, reason: "unknown" };
  const pending = await meta
    .selectFrom("station_device_requests")
    .select(["id", "org_slug", "address"])
    .where("code_hash", "=", sha(code))
    .where("approved_at", "is", null)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (!pending) return { ok: false, reason: "unknown" };
  if (pending.org_slug !== p.orgSlug) return { ok: false, reason: "other_workspace" };
  const label = (p.label ?? "").trim().slice(0, 60) || stationLabelOf(pending.address);
  const done = await meta
    .updateTable("station_device_requests")
    .set({ approved_by: p.userId, approved_org: p.orgId, approved_at: new Date(), label })
    .where("id", "=", pending.id)
    .where("approved_at", "is", null)
    .returning(["address"])
    .executeTakeFirst();
  if (!done) return { ok: false, reason: "unknown" };
  return { ok: true, address: done.address, label };
}

export type ClaimResult =
  | { status: "pending"; expires_at: string }
  | { status: "approved"; token: string; slug: string; address: string; label: string }
  | { status: "gone" };

/** The tablet's poll. Once approved, the first claim mints the token and
 *  marks the request claimed in the same statement, so two tabs racing with
 *  one poll key get one token. */
export async function claimStation(requestId: string, pollKey: unknown): Promise<ClaimResult> {
  if (typeof pollKey !== "string" || !/^[0-9a-f-]{36}$/.test(requestId)) return { status: "gone" };
  const row = await meta
    .selectFrom("station_device_requests")
    .select(["expires_at", "approved_at", "claimed_at"])
    .where("id", "=", requestId)
    .where("poll_hash", "=", sha(pollKey))
    .executeTakeFirst();
  if (!row || row.claimed_at) return { status: "gone" };
  if (!row.approved_at) {
    return row.expires_at > new Date() ? { status: "pending", expires_at: row.expires_at.toISOString() } : { status: "gone" };
  }
  const claimed = await meta
    .updateTable("station_device_requests")
    .set({ claimed_at: new Date() })
    .where("id", "=", requestId)
    .where("claimed_at", "is", null)
    .returning(["approved_by", "approved_org", "address", "label", "org_slug"])
    .executeTakeFirst();
  if (!claimed?.approved_by || !claimed.approved_org) return { status: "gone" };

  // Whoever approved must still be able to: an approval by an admin who has
  // since been removed does not outlive them.
  const who = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["o.slug", "m.role", "u.active"])
    .where("m.org_id", "=", claimed.approved_org)
    .where("m.user_id", "=", claimed.approved_by)
    .executeTakeFirst();
  if (!who || !who.active || !roleSatisfies(who.role, ["owner", "admin"])) return { status: "gone" };

  const label = claimed.label ?? stationLabelOf(claimed.address);
  const { plaintext, hash, tokenPrefix } = mintTokenString();
  await meta
    .insertInto("api_tokens")
    .values({
      user_id: claimed.approved_by,
      name: stationDeviceName(label),
      token_hash: hash,
      token_prefix: tokenPrefix,
      expires_at: null,
      scopes: [stationScope(claimed.address)],
      source: STATION_TOKEN_SOURCE,
      meta: { kind: "station", address: claimed.address, label },
      org_id: claimed.approved_org,
      access: "change",
    })
    .execute();
  return { status: "approved", token: plaintext, slug: who.slug, address: claimed.address, label };
}

export interface StationDevice {
  id: string;
  name: string;
  address: string;
  label: string;
  approved_by: string;
  created_at: string;
  last_used_at: string | null;
}

/** The approved station devices of a workspace, newest first. */
export async function listStationDevices(orgId: string): Promise<StationDevice[]> {
  const rows = await meta
    .selectFrom("api_tokens as t")
    .innerJoin("users as u", "u.id", "t.user_id")
    .select(["t.id", "t.name", "t.scopes", "t.meta", "t.created_at", "t.last_used_at", "u.display_name", "u.email"])
    .where("t.org_id", "=", orgId)
    .where("t.source", "=", STATION_TOKEN_SOURCE)
    .where("t.revoked_at", "is", null)
    .orderBy("t.created_at", "desc")
    .execute();
  return rows.flatMap((r) => {
    const address = (r.scopes ?? []).map(stationAddressOfScope).find((a): a is string => !!a);
    if (!address) return [];
    const m = (r.meta ?? {}) as { label?: unknown };
    return [{
      id: r.id,
      name: r.name,
      address,
      label: typeof m.label === "string" ? m.label : stationLabelOf(address),
      approved_by: r.display_name || r.email,
      created_at: r.created_at.toISOString(),
      last_used_at: r.last_used_at ? r.last_used_at.toISOString() : null,
    }];
  });
}

/** Stop one station device. True when there was one to stop. */
export async function revokeStationDevice(orgId: string, tokenId: string): Promise<boolean> {
  const r = await meta
    .updateTable("api_tokens")
    .set({ revoked_at: new Date() })
    .where("id", "=", tokenId)
    .where("org_id", "=", orgId)
    .where("source", "=", STATION_TOKEN_SOURCE)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0) > 0;
}

// ── A station's kitchen QR (#5353) ───────────────────────────────────────
// The owner, of the kitchen station: "a qr label with the link should let me
// (or anyone else?) do the same thing from their phone." A member signed in
// on their phone needs nothing here: the station's routes take them as
// themselves. For someone with no account, an owner or admin turns the QR on
// and prints it. Its link carries a key; a phone that opens it claims a token
// with scope `station-qr:<address>`, which reaches that station's lookup and
// only the presses the owner ticked (core-scan checks which). Printing a new
// label replaces the key and revokes every token the old one gave out.

/** The source every kitchen QR token carries, so rotation finds them. */
export const STATION_QR_TOKEN_SOURCE = "station qr";

async function revokeStationQrTokens(orgId: string, address: string): Promise<void> {
  await meta
    .updateTable("api_tokens")
    .set({ revoked_at: new Date() })
    .where("org_id", "=", orgId)
    .where("source", "=", STATION_QR_TOKEN_SOURCE)
    .where("revoked_at", "is", null)
    .where(sql<boolean>`${stationQrScope(address)} = any(scopes)`)
    .execute();
}

/** Turn the QR on, or print a new one: a fresh key, and every phone that
 *  claimed the old one stops working. Null for an address that cannot be a
 *  station. The key is returned once, for the label; only its hash is kept. */
export async function rotateStationQr(p: { orgId: string; userId: string; address: string }): Promise<{ key: string } | null> {
  if (!isStationAddress(p.address)) return null;
  const key = randomBytes(24).toString("base64url");
  await revokeStationQrTokens(p.orgId, p.address);
  await meta
    .insertInto("station_qr_keys")
    .values({ org_id: p.orgId, address: p.address, key_hash: sha(key), enabled_by: p.userId })
    .onConflict((oc) => oc.columns(["org_id", "address"]).doUpdateSet({ key_hash: sha(key), enabled_by: p.userId, created_at: new Date() }))
    .execute();
  return { key };
}

/** Turn the QR off: the key is gone and so is every phone it let in. */
export async function disableStationQr(orgId: string, address: string): Promise<void> {
  await meta.deleteFrom("station_qr_keys").where("org_id", "=", orgId).where("address", "=", address).execute();
  await revokeStationQrTokens(orgId, address);
}

/** Whether the station's QR is on, and since when (the label's age). */
export async function stationQrState(orgId: string, address: string): Promise<{ enabled: boolean; printed_at: string | null; phones: number }> {
  const row = await meta.selectFrom("station_qr_keys").select(["created_at"]).where("org_id", "=", orgId).where("address", "=", address).executeTakeFirst();
  const phones = await meta
    .selectFrom("api_tokens")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("source", "=", STATION_QR_TOKEN_SOURCE)
    .where("revoked_at", "is", null)
    .where(sql<boolean>`${stationQrScope(address)} = any(scopes)`)
    .executeTakeFirst();
  return { enabled: !!row, printed_at: row ? row.created_at.toISOString() : null, phones: Number(phones?.n ?? 0) };
}

export type StationQrClaim = { ok: true; token: string; slug: string; address: string; label: string } | { ok: false };

/** A phone opened the label: the key buys a token for that one station, if
 *  the QR is still on, the key is the current one, and whoever turned it on
 *  is still an owner or admin. Every refusal looks the same. */
export async function claimStationQr(p: { slug?: unknown; address?: unknown; key?: unknown }): Promise<StationQrClaim> {
  if (typeof p.slug !== "string" || typeof p.address !== "string" || typeof p.key !== "string" || p.key.length < 20 || p.key.length > 100) return { ok: false };
  if (!isStationAddress(p.address)) return { ok: false };
  const row = await meta
    .selectFrom("station_qr_keys as k")
    .innerJoin("orgs as o", "o.id", "k.org_id")
    .innerJoin("org_memberships as m", (j) => j.onRef("m.org_id", "=", "k.org_id").onRef("m.user_id", "=", "k.enabled_by"))
    .innerJoin("users as u", "u.id", "k.enabled_by")
    .select(["k.org_id", "k.key_hash", "k.enabled_by", "o.slug", "m.role", "u.active"])
    .where("o.slug", "=", p.slug)
    .where("k.address", "=", p.address)
    .executeTakeFirst();
  if (!row) return { ok: false };
  const given = Buffer.from(sha(p.key), "hex");
  const kept = Buffer.from(row.key_hash, "hex");
  if (given.length !== kept.length || !timingSafeEqual(given, kept)) return { ok: false };
  if (!row.active || !roleSatisfies(row.role, ["owner", "admin"])) return { ok: false };
  const label = stationLabelOf(p.address);
  const { plaintext, hash, tokenPrefix } = mintTokenString();
  await meta
    .insertInto("api_tokens")
    .values({
      user_id: row.enabled_by,
      name: stationQrName(label),
      token_hash: hash,
      token_prefix: tokenPrefix,
      expires_at: null,
      scopes: [stationQrScope(p.address)],
      source: STATION_QR_TOKEN_SOURCE,
      meta: { kind: "station-qr", address: p.address, label },
      org_id: row.org_id,
      access: "change",
    })
    .execute();
  return { ok: true, token: plaintext, slug: row.slug, address: p.address, label };
}
