// Where a Discord reporter's screenshots are kept.
//
// A reporter who wrote in a chat channel has no Cobblr account and no workspace,
// so the feedback row's org_id is null and must stay that way: filling it in
// would claim they have an install we cannot see, which is the opposite of the
// "no workspace linked" the card now says honestly.
//
// But the bytes need to live somewhere. Discord's CDN links are signed and
// expire within about a day, so keeping the URL alone means a report loses its
// screenshots before anybody works the queue — which is exactly when a UI report
// needs them, since it is usually a picture and a sentence.
//
// So they are stored in the OPERATOR's own workspace, and the attachment entry
// records which org that was. Nothing about the reporter changes.
//
// Resolution order:
//   1. COBBLR_FEEDBACK_ATTACHMENT_ORG — an explicit org id, for an operator who
//      wants them somewhere specific.
//   2. the first workspace owned by the first address in SUPERADMIN_EMAILS, so
//      this works on a fresh install with no extra configuration.
//   3. null — store nothing, and say so. A deployment with no superadmin
//      workspace is a real state (the public instance early on), and dropping a
//      screenshot silently is what this whole change exists to stop.

export async function feedbackAttachmentOrg(): Promise<string | null> {
  const explicit = (process.env.COBBLR_FEEDBACK_ATTACHMENT_ORG || "").trim();
  if (explicit) return explicit;

  const first = (process.env.SUPERADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)[0];
  if (!first) return null;

  try {
    // Imported HERE, not at module scope. db/meta reaches env, and env exits the
    // process when the database vars are absent, so a module-level import would
    // make this file unloadable in a unit test — the same reason announce-url.ts
    // is a leaf. Only the branch that genuinely needs a database pays for one.
    const { meta } = await import("../db/meta.js");
    const row = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["m.org_id"])
      .where(({ fn, ref }) => fn("lower", [ref("u.email")]), "=", first)
      // An owner's own workspace, not one they were invited to: the operator's
      // storage should not quietly fill somebody else's workspace.
      .where("m.role", "=", "owner")
      .orderBy("m.joined_at", "asc")
      .limit(1)
      .executeTakeFirst();
    return row?.org_id ?? null;
  } catch {
    return null;
  }
}
