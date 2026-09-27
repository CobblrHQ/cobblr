// Kept item photos and the person they came from (CobblrHQ/core#3769).
//
// The shared network keeps a confirmed item photo indefinitely and its link to
// the person (an opaque actor id) for up to two years. Two things reach it from
// an install, both keyed by that same actor id:
//   unlink  the account was deleted: its photos keep no person;
//   forget  the person asked for their photos to be deleted outright.
// Deleting an item sends nothing: it is not a privacy request.
//
// The actor id is the one rule every door must agree on, since the network can
// only find a person's photos by the id they were filed under. core-scan files
// with it and the platform unlinks and forgets with it, so it lives here once.
//
// Server-side only: deliberately NOT re-exported from index.ts, because the web
// bundle imports that and has no `process`.
import crypto from "node:crypto";

/** Opaque per-person actor id: an HMAC of the user id with the install's
 *  secret. Never a name, an email or a workspace. */
export function opaqueUserActor(userId: string | null | undefined, secret: string | null | undefined): string | null {
  if (!userId || !secret) return null;
  return "u_" + crypto.createHmac("sha256", secret).update(userId).digest("hex").slice(0, 16);
}

export type PhotoRetentionKind = "unlink" | "forget";

export interface PhotoRetentionTarget {
  unlink: string;
  forget: string;
  token: string;
}

/** Where retention requests go: a directly configured resolver with its
 *  correction token, else the hosted network edge with the install key. Null
 *  when this install reaches no network, so it can have sent no photo. */
export function photoRetentionTarget(env: Record<string, string | undefined> = process.env): PhotoRetentionTarget | null {
  const resolver = (env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const resolverTok = env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "";
  if (resolver && resolverTok) return { unlink: `${resolver}/observe/unlink`, forget: `${resolver}/observe/forget`, token: resolverTok };
  const bidb = (env.COBBLR_BIDB_URL ?? "").replace(/\/+$/, "");
  const key = (env.COBBLR_BIDB_KEY ?? "").trim();
  if (bidb && key) return { unlink: `${bidb}/v1/observe/unlink`, forget: `${bidb}/v1/observe/forget`, token: key };
  return null;
}

/** Send one request. Resolves with how many photos it touched; throws on any
 *  answer that is not a success, so the caller keeps the request and retries. */
export async function sendPhotoRetention(
  kind: PhotoRetentionKind,
  actor: string,
  target: PhotoRetentionTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const r = await fetchImpl(kind === "unlink" ? target.unlink : target.forget, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
    body: JSON.stringify({ corrected_by: actor }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await r.json().catch(() => ({}))) as { unlinked?: number; removed?: number; error?: string };
  if (!r.ok) throw new Error(`${kind} answered ${r.status}${j.error ? ` ${j.error}` : ""}`);
  return Number(kind === "unlink" ? j.unlinked : j.removed) || 0;
}
