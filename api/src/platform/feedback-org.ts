// Which workspace a report is filed under.
//
// The slug in the body is only a hint from the browser: it can be stale (a tab
// open across a rename) or simply not the reporter's. A report filed under a
// workspace its author does not belong to puts that workspace's name on the
// operator's card and points the screenshot fetch at its files, so the hint
// counts only when the reporter is a member of the workspace it names;
// otherwise the report is filed under the reporter's own first workspace.

export interface ReportingOrgCandidates {
  /** The org the body's slug names, if any, and whether the reporter belongs to it. */
  bySlug: { id: string; isMember: boolean } | null;
  /** The reporter's own first workspace, if they have one. */
  firstOwn: string | null;
}

export function reportingOrgId(c: ReportingOrgCandidates): string | null {
  if (c.bySlug?.isMember) return c.bySlug.id;
  return c.firstOwn;
}
