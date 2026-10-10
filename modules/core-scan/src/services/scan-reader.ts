// Whose AI reads a scan's photo (#5404). The read runs detached, from the
// wire on scan.received, and a scan that came in with no person signed in
// behind the request (a scan station, a forwarded email, a drive folder)
// reaches it with no user at all. The person who made the scan is still on
// the row, and their own default AI for reading photos is what they chose
// for exactly this, so the read is theirs.
export function scanReader(actingUserId: string | null | undefined, row: { created_by_user_id?: string | null }): string | null {
  return actingUserId ?? row.created_by_user_id ?? null;
}
