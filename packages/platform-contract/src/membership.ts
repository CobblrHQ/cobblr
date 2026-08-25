// "A workspace notification reaches only CURRENT members of that workspace."
//
// One definition of that rule, so the platform dispatcher and the discussion
// module cannot drift on it. The QUERY for who is a member lives server-side
// (api/src/platform/memberships.ts orgMemberIds — it hits cobblr_meta); this is
// the pure FILTER that both sides apply to the answer.
//
// Why it exists: a member of workspace A could hand-craft a mention token for
// any real user's uuid and that user — even a non-member, even a stranger — got
// a Cobblr-branded DM carrying attacker-chosen text (cross-tenant messaging /
// phishing / a uuid-liveness oracle). And a user REMOVED from a workspace who
// still had follow/mention rows kept receiving that workspace's comment content
// over Discord. Both are the same missing check: the audience was never
// intersected with live membership.

/** Drop every candidate who is not a current member of the workspace, keeping
 *  order and de-duping nothing (callers pass Sets where uniqueness matters).
 *  Membership is the WHOLE gate: no member row → no delivery, no follow. */
export function keepMembers(
  candidateIds: Iterable<string>,
  memberIds: ReadonlySet<string>,
): string[] {
  return [...candidateIds].filter((id) => memberIds.has(id));
}

/** True iff `userId` is a current member of the workspace. The single-recipient
 *  shape of the same rule — used where the audience is one person (the platform
 *  dispatcher fans one user at a time). */
export function isMember(userId: string, memberIds: ReadonlySet<string>): boolean {
  return memberIds.has(userId);
}

/** Who a parcel notification interrupts: its OWNER, figured out automatically.
 *
 *  A parcel belongs to whoever touched its journey last — the person who added
 *  the tracking number, else whoever captured the receipt. Broadcasting it to
 *  the whole workspace was wrong twice over: a family workspace hears about
 *  every member's orders (noise, and mildly private), and the one person who
 *  actually cares gets the same ping as everyone who does not.
 *
 *  `candidates` is that priority order. The first candidate who is still a
 *  CURRENT member wins and is the entire audience. When nobody qualifies —
 *  legacy rows from before ownership was stamped, or an owner who left the
 *  workspace — it falls back to every member, because a parcel someone must
 *  deal with beats a parcel nobody hears about.
 *
 *  Pure, so both sweepers assert it without a database; lives here because two
 *  modules apply it and module isolation forbids them sharing it any other
 *  way. */
export function parcelAudience(
  candidates: ReadonlyArray<string | null | undefined>,
  memberIds: ReadonlySet<string>,
): string[] {
  for (const c of candidates) {
    if (c && memberIds.has(c)) return [c];
  }
  return [...memberIds];
}

