// A /w/<handle>/… URL that names no workspace this account can open: a tab,
// bookmark or history entry for a workspace that was deleted, or one the
// person was removed from, or a typo. It used to draw the whole workspace
// shell around nothing, with a blank name in the header (#3531). It goes
// where the bare URL goes instead, and says why, across the full-document
// navigation that takes it there (hence sessionStorage: one tab, one read).

const KEY = "cobblr.goneWorkspace";

export function noteGoneWorkspace(handle: string): void {
  try {
    sessionStorage.setItem(KEY, handle);
  } catch {
    /* private mode or blocked storage: the redirect still happens, unexplained */
  }
}

/** The handle that was not there, once. Reading it clears it, so a reload of
 *  the page the redirect landed on does not repeat the notice. */
export function takeGoneWorkspace(): string | null {
  try {
    const handle = sessionStorage.getItem(KEY);
    if (handle !== null) sessionStorage.removeItem(KEY);
    return handle || null;
  } catch {
    return null;
  }
}

export function goneWorkspaceMessage(handle: string): string {
  return `There is no workspace at /w/${handle} that you can open. It may have been deleted, or you may no longer be a member.`;
}
