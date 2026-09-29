// Whether an account lets Cobblr keep photos of the things it files (#3769
// step 3, prepared). One place decides and records it; the Your account
// setting and the terms prompt both call here.
//
// - Turning it on records acceptance with its date.
// - Turning it off (a decline of the updated terms, or a withdrawal after
//   accepting) records the decline with its date, stops any new photo being
//   kept at once (photoObservationGate refuses a declined account), and, for
//   an account that had accepted, unlinks the photos already kept: the same
//   request an account deletion sends (queuePhotoRetention "unlink"), queued
//   before the acceptance is cleared, because the queue only acts for an
//   account that accepted.
// - Every decision is logged in photo_consent_log.
// - A trial account can neither accept nor decline: it never keeps a photo.
// Off (COBBLR_PHOTO_OBSERVATIONS) until the terms ship: nothing is set.
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { queuePhotoRetention } from "./photo-retention.js";
import { isSandboxUser } from "./try-sandbox.js";

export interface PhotoConsent {
  /** The setting exists on this deployment (the terms have shipped). */
  available: boolean;
  keep: boolean;
  accepted_at: string | null;
  declined_at: string | null;
}

export function photoConsentAvailable(): boolean {
  return env.COBBLR_PHOTO_OBSERVATIONS;
}

export async function photoConsentOf(userId: string): Promise<PhotoConsent> {
  const r = await sql<{ accepted: Date | null; declined: Date | null }>`
    select photo_terms_accepted_at as accepted, photo_terms_declined_at as declined from users where id = ${userId}
  `.execute(meta);
  const row = r.rows[0];
  const accepted = row?.accepted ?? null;
  const declined = row?.declined ?? null;
  return {
    // A trial account is never offered it: the trial never keeps a photo.
    available: photoConsentAvailable() && !(await isSandboxUser(userId)),
    keep: !!accepted && !declined,
    accepted_at: accepted ? new Date(accepted).toISOString() : null,
    declined_at: declined ? new Date(declined).toISOString() : null,
  };
}

export class PhotoConsentRefused extends Error {
  constructor(
    readonly code: "not_available" | "trial",
    message: string,
  ) {
    super(message);
  }
}

/** Set the account's choice. Returns the new state and whether photos already
 *  kept were queued to be unlinked. */
export async function setPhotoConsent(
  userId: string,
  keep: boolean,
  opts: { available?: boolean } = {},
): Promise<PhotoConsent & { unlinked: boolean }> {
  if (!(opts.available ?? photoConsentAvailable())) {
    throw new PhotoConsentRefused("not_available", "Keeping photos of filed items is not offered here yet.");
  }
  if (await isSandboxUser(userId)) {
    throw new PhotoConsentRefused("trial", "The trial never keeps a photo.");
  }
  const before = await photoConsentOf(userId);
  let unlinked = false;
  if (keep) {
    await sql`update users set photo_terms_accepted_at = now(), photo_terms_declined_at = null where id = ${userId}`.execute(meta);
    await sql`insert into photo_consent_log (user_id, decision) values (${userId}, 'accept')`.execute(meta);
  } else {
    // Queued while the acceptance still stands: the queue acts only for an
    // account that accepted, and once it is cleared nothing could ask.
    if (before.keep) unlinked = await queuePhotoRetention("unlink", userId);
    await sql`update users set photo_terms_declined_at = now(), photo_terms_accepted_at = null where id = ${userId}`.execute(meta);
    await sql`insert into photo_consent_log (user_id, decision) values (${userId}, ${before.keep ? "withdraw" : "decline"})`.execute(meta);
  }
  return { ...(await photoConsentOf(userId)), unlinked };
}
