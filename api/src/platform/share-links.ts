// Pairing a workspace with a share space, on this Cobblr or another one.
//
// The owner asks to share with someone: their workspace gets a pending link
// and a single-use invite. The person opens the invite on THEIR Cobblr (the
// share space lives where their account is, docs/design-decisions/
// share-spaces.md §1a), accepts, and their Cobblr makes the share space and
// claims the invite from the owner's Cobblr with the code. The claim carries
// two keys, one for each direction: each side signs what it sends with one and
// checks what it receives against the other. Either side can end it; ending
// it stops sync at once and takes the share space away.
//
// Nothing here trusts what the other side says about itself beyond the code
// and the keys: names arrive for display only, and what a change may do is
// decided by the side that applies it.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { encryptCreds } from "../db/crypto.js";
import { provisionOrgForUser } from "../routes/auth.js";
import { shapeShareSpace } from "./reconcile-share-spaces.js";
import { hardDeleteOrg } from "./delete-org.js";
import {
  SHARE_ENVELOPE_VERSION,
  enqueueShareOp,
  getShareLink,
  peerFetch,
  registerShareOp,
  REVOKED_OP,
  type ShareLinkRow,
} from "./share-sync.js";

export const INVITE_TTL_MS = 7 * 86_400_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

/** A key one side signs with: `<keyId>.<secret>` (the services key shape). */
export function mintShareKey(): { keyId: string; secret: string; text: string } {
  const keyId = `shl_${randomBytes(9).toString("hex")}`;
  const secret = b64url(randomBytes(32));
  return { keyId, secret, text: `${keyId}.${secret}` };
}

/** What an invite link carries after its `#`: where the owner's Cobblr is and
 *  the code. Names ride along for the page to show before it asks. */
export interface InviteToken {
  u: string;
  c: string;
  n?: string;
  w?: string;
}
export const encodeInvite = (t: InviteToken) => b64url(Buffer.from(JSON.stringify(t)));
export function decodeInvite(s: string): InviteToken | null {
  try {
    const t = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as InviteToken;
    return typeof t.u === "string" && typeof t.c === "string" ? t : null;
  } catch {
    return null;
  }
}

/** This Cobblr's own address: the configured one, else the one the request
 *  came in on (a dev box with none configured). */
export function hereUrl(requestOrigin?: string | null): string {
  return (publicBaseUrl() || requestOrigin || "").replace(/\/+$/, "");
}

const sameInstance = (url: string, here: string) => !!here && url.replace(/\/+$/, "") === here;

async function orgOf(orgId: string) {
  return meta.selectFrom("orgs").select(["id", "name", "slug", "kind"]).where("id", "=", orgId).executeTakeFirst();
}

async function userName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await meta.selectFrom("users").select(["display_name", "email"]).where("id", "=", userId).executeTakeFirst();
  return u?.display_name || u?.email?.split("@")[0] || null;
}

/** The owner starts a share: a pending link and the invite to send. */
export async function createShareInvite(p: {
  orgId: string;
  userId: string;
  label: string;
  here: string;
}): Promise<{ linkId: string; inviteUrl: string; expiresAt: Date }> {
  const org = await orgOf(p.orgId);
  if (!org) throw new Error("no such workspace");
  if (org.kind === "share") throw new Error("A share space cannot be shared on; share from your own workspace.");
  if (!p.here) throw new Error("This Cobblr does not know its own address (PUBLIC_BASE_URL), so an invite could not reach it.");
  const code = b64url(randomBytes(24));
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const row = await meta
    .insertInto("share_links")
    .values({
      org_id: p.orgId,
      side: "owner",
      status: "pending",
      label: p.label.trim().slice(0, 120) || null,
      invite_code_hash: hash(code),
      invite_expires_at: expiresAt,
      created_by: p.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const token = encodeInvite({ u: p.here, c: code, n: (await userName(p.userId)) ?? undefined, w: org.name });
  return { linkId: row.id, inviteUrl: `${p.here}/share/join#${token}`, expiresAt };
}

async function pendingInvite(code: string) {
  const row = await meta
    .selectFrom("share_links as l")
    .innerJoin("orgs as o", "o.id", "l.org_id")
    .select(["l.id", "l.org_id", "l.created_by", "l.invite_expires_at", "l.status", "o.name as workspace_name"])
    .where("l.invite_code_hash", "=", hash(code))
    .executeTakeFirst();
  if (!row || row.status !== "pending" || !row.invite_expires_at || row.invite_expires_at < new Date()) return null;
  return row;
}

/** What an invite says, asked of the owner's Cobblr before anything is made. */
export async function previewInvite(code: string): Promise<{ owner_name: string | null; workspace_name: string; v: number } | null> {
  const row = await pendingInvite(code);
  if (!row) return null;
  return { owner_name: await userName(row.created_by), workspace_name: row.workspace_name, v: SHARE_ENVELOPE_VERSION };
}

export interface ClaimRequest {
  code: string;
  /** Where the share space's Cobblr is; empty when it is this one. */
  share_url: string;
  share_link_id: string;
  person_name: string;
  share_workspace_name: string;
  /** The key the owner's side signs with (toward the share). */
  key_to_share: string;
  /** The key the share's side signs with (toward the owner). */
  key_to_owner: string;
  v: number;
}

/** The owner's side of accepting: the code is spent, the keys are kept, the
 *  link is live. Refuses an unknown, used or expired code. */
export async function claimShareInvite(req: ClaimRequest): Promise<{ owner_link_id: string; owner_name: string | null; workspace_name: string; v: number } | null> {
  const row = await pendingInvite(req.code);
  if (!row) return null;
  const toOwner = req.key_to_owner.split(".");
  const claimed = await meta
    .updateTable("share_links")
    .set({
      status: "active",
      invite_code_hash: null,
      peer_url: req.share_url || null,
      peer_link_id: req.share_link_id,
      peer_name: req.person_name.slice(0, 120) || null,
      peer_workspace_name: req.share_workspace_name.slice(0, 200) || null,
      send_key_encrypted: encryptCreds(req.key_to_share),
      receive_key_id: toOwner[0] ?? null,
      receive_secret_encrypted: encryptCreds(toOwner.slice(1).join(".")),
      peer_version: req.v,
      last_synced_at: new Date(),
    })
    .where("id", "=", row.id)
    .where("status", "=", "pending")
    .returning("id")
    .executeTakeFirst();
  if (!claimed) return null;
  return { owner_link_id: row.id, owner_name: await userName(row.created_by), workspace_name: row.workspace_name, v: SHARE_ENVELOPE_VERSION };
}

export class ShareInviteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function askOwner<T>(ownerUrl: string, path: string, init: RequestInit): Promise<T | null> {
  let res: Response;
  try {
    res = await peerFetch("", `${ownerUrl}${path}`, init);
  } catch (err) {
    throw new ShareInviteError(502, `Could not reach ${new URL(ownerUrl).host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const said = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ShareInviteError(502, said?.error?.message ?? `${new URL(ownerUrl).host} answered ${res.status}`);
  }
  return (await res.json()) as T;
}

/** What an invite is, asked of the Cobblr it came from: who shares, from
 *  which workspace, and whether this one is the same Cobblr. */
export async function readInvite(token: InviteToken, here: string): Promise<{
  ownerUrl: string;
  local: boolean;
  preview: { owner_name: string | null; workspace_name: string; v: number };
}> {
  const ownerUrl = token.u.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(ownerUrl)) throw new ShareInviteError(400, "That invite does not say which Cobblr it came from.");
  const local = sameInstance(ownerUrl, here);
  const preview = local
    ? await previewInvite(token.c)
    : await askOwner<{ owner_name: string | null; workspace_name: string; v: number }>(ownerUrl, `/api/v1/share-links/invite/${encodeURIComponent(token.c)}`, { method: "GET" });
  if (!preview) throw new ShareInviteError(404, "That invite is used, expired or was withdrawn. Ask for a new one.");
  return { ownerUrl, local, preview };
}

/** The person's side of accepting, on their own Cobblr: ask the owner's
 *  Cobblr what the invite is, make the share space, then claim the invite. A
 *  claim that fails takes the new share space away again. */
export async function acceptShareInvite(p: { userId: string; token: InviteToken; here: string }): Promise<{ orgId: string; slug: string; linkId: string }> {
  const { ownerUrl, local, preview } = await readInvite(p.token, p.here);
  if (preview.v > SHARE_ENVELOPE_VERSION) throw new ShareInviteError(409, "The Cobblr that sent this invite is newer than this one, which needs updating to accept it.");

  const owner = preview.owner_name || preview.workspace_name;
  const shareName = `${owner}'s workspace (shared)`;
  const made = await provisionOrgForUser(p.userId, shareName);
  const linkId = randomUUID();
  try {
    await meta.updateTable("orgs").set({ kind: "share" }).where("id", "=", made.orgId).execute();
    // The person is an admin here, not its owner: they can do anything in it,
    // and the share itself (ending it, who is in it) is the sharer's.
    await shapeShareSpace(made.orgId);

    const toShare = mintShareKey();
    const toOwner = mintShareKey();
    const claim: ClaimRequest = {
      code: p.token.c,
      share_url: local ? "" : p.here,
      share_link_id: linkId,
      person_name: (await userName(p.userId)) ?? "",
      share_workspace_name: shareName,
      key_to_share: toShare.text,
      key_to_owner: toOwner.text,
      v: SHARE_ENVELOPE_VERSION,
    };
    const got = local
      ? await claimShareInvite(claim)
      : await askOwner<{ owner_link_id: string; owner_name: string | null; workspace_name: string; v: number }>(ownerUrl, "/api/v1/share-links/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // jsonb-replace-ok: an HTTP request body, not a column
          body: JSON.stringify(claim),
        });
    if (!got) throw new ShareInviteError(404, "That invite is used, expired or was withdrawn. Ask for a new one.");
    await meta
      .insertInto("share_links")
      .values({
        id: linkId,
        org_id: made.orgId,
        side: "share",
        status: "active",
        peer_url: local ? null : ownerUrl,
        peer_link_id: got.owner_link_id,
        peer_name: got.owner_name,
        peer_workspace_name: got.workspace_name,
        send_key_encrypted: encryptCreds(toOwner.text),
        receive_key_id: toShare.keyId,
        receive_secret_encrypted: encryptCreds(toShare.secret),
        created_by: p.userId,
        peer_version: got.v,
        last_synced_at: new Date(),
      })
      .execute();
    await enqueueShareOp(linkId, "link.hello", { name: shareName });
    return { orgId: made.orgId, slug: made.slug, linkId };
  } catch (err) {
    await hardDeleteOrg(made.orgId).catch((e) => console.error(`[share] could not take back share space ${made.orgId}:`, e));
    throw err;
  }
}

export interface ShareLinkView {
  id: string;
  side: "owner" | "share";
  status: "pending" | "active" | "revoked";
  label: string | null;
  peer_name: string | null;
  peer_workspace_name: string | null;
  /** Where the other side is: null on this Cobblr. */
  peer_host: string | null;
  last_synced_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  invite_expires_at: Date | null;
  /** Changes waiting to reach the other side. */
  waiting: number;
  /** The friend's edits waiting for the owner to decide. */
  edits_waiting: number;
  /** Whether the friend's edits apply at once ("direct") or wait ("suggest"). */
  edit_mode: "suggest" | "direct";
  created_at: Date;
}

export async function listShareLinks(orgId: string): Promise<ShareLinkView[]> {
  const rows = await meta
    .selectFrom("share_links as l")
    .leftJoin("share_outbox as o", (j) => j.onRef("o.link_id", "=", "l.id").on("o.sent_at", "is", null))
    .select((eb) => [
      "l.id",
      "l.side",
      "l.status",
      "l.label",
      "l.peer_name",
      "l.peer_workspace_name",
      "l.peer_url",
      "l.last_synced_at",
      "l.last_error",
      "l.last_error_at",
      "l.invite_expires_at",
      "l.created_at",
      eb.fn.count<string>("o.id").as("waiting"),
      eb
        .selectFrom("share_suggestions as s")
        .select((e) => e.fn.countAll<string>().as("n"))
        .whereRef("s.link_id", "=", "l.id")
        .where("s.status", "in", ["pending", "conflict"])
        .as("edits_waiting"),
      sql<string | null>`l.settings->>'edit_mode'`.as("edit_mode"),
    ])
    .where("l.org_id", "=", orgId)
    .where("l.status", "!=", "revoked")
    .groupBy("l.id")
    .orderBy("l.created_at", "desc")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    side: r.side,
    status: r.status,
    label: r.label,
    peer_name: r.peer_name,
    peer_workspace_name: r.peer_workspace_name,
    peer_host: r.peer_url ? new URL(r.peer_url).host : null,
    last_synced_at: r.last_synced_at,
    last_error: r.last_error,
    last_error_at: r.last_error_at,
    invite_expires_at: r.status === "pending" ? r.invite_expires_at : null,
    waiting: Number(r.waiting ?? 0),
    edits_waiting: Number(r.edits_waiting ?? 0),
    edit_mode: r.edit_mode === "direct" ? "direct" : "suggest",
    created_at: r.created_at,
  }));
}

/** End a share from this side. The other side is told (best effort, at
 *  once, since after this nothing more is sent); a share space goes with it. */
export async function revokeShareLink(orgId: string, linkId: string): Promise<boolean> {
  const link = await getShareLink(linkId);
  if (!link || link.org_id !== orgId || link.status === "revoked") return false;
  const wasActive = link.status === "active";
  await endLink(link);
  // The other side hears it as soon as it can be reached: the notice stays
  // queued (the one change a revoked link still sends) until it arrives.
  if (wasActive) await enqueueShareOp(linkId, REVOKED_OP, {});
  return true;
}

async function endLink(link: ShareLinkRow): Promise<void> {
  await meta.updateTable("share_links").set({ status: "revoked", revoked_at: new Date(), invite_code_hash: null }).where("id", "=", link.id).execute();
  // Nothing else is said over an ended share.
  await meta.deleteFrom("share_outbox").where("link_id", "=", link.id).where("sent_at", "is", null).where("op", "!=", REVOKED_OP).execute();
  if (link.side === "share") {
    const org = await orgOf(link.org_id);
    if (org?.kind === "share") await hardDeleteOrg(org.id).catch((err) => console.error(`[share] could not remove share space ${org.id}:`, err));
  }
}

/** The changes every link understands, whatever is shared over it. */
export function registerShareLinkOps(): void {
  // The other side says who it is now (a rename, a first hello).
  registerShareOp("link.hello", async (link, payload) => {
    const name = typeof payload.name === "string" ? payload.name.slice(0, 200) : null;
    if (name) await meta.updateTable("share_links").set({ peer_workspace_name: name }).where("id", "=", link.id).execute();
  });
  // The other side ended it.
  registerShareOp(REVOKED_OP, async (link) => {
    await endLink(link);
  });
}
