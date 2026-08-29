// What a sandbox is allowed to upload, as a pure decision.
//
// Split out for the same reason as the token and the reaper query: the rule is
// worth testing, and importing trial.ts drags in the env schema and the meta
// pool. A rule about storing strangers' bytes should not need a database to
// check.
//
// The trial tier BANS user uploads, correctly: a free tier that stores bytes
// people choose is free file hosting. A sandbox is the one place that is wrong,
// because it is deleted — database and all — an hour after it is made, so
// nothing can be hosted in it. And with the ban in place the camera does not
// work at all (the scan photo route takes a file_id, so the browser uploads
// first), which removes the one feature the sandbox exists to show.

/** Per-file ceiling for a sandbox upload. Above a phone photo (2-5 MB is
 *  typical), well below a video or an archive. */
export const SANDBOX_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface UploadVerdict {
  allow: boolean;
  reason?: string;
}

/** Allow a sandbox upload if it is plausibly a photo. `bytes` is the size the
 *  entitlement seam reports; an absent or nonsensical value fails closed, which
 *  is the right way round for a rule about hosting. */
export function sandboxUploadDecision(bytes: unknown): UploadVerdict {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return { allow: false, reason: "We could not size that upload." };
  }
  return bytes <= SANDBOX_MAX_UPLOAD_BYTES
    ? { allow: true }
    : { allow: false, reason: "That file is too big for a sandbox. Make an account to upload larger files." };
}
