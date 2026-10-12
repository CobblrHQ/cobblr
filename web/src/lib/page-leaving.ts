// A page that changes whose credentials the tab carries, and then navigates
// (leaving a View as session, opening a share's View as), stops asking the
// api first. Between the change and the navigation its own polls went out
// with the new credentials, which the server rightly refused: a share's grant
// reads only the share space, an ended session nothing. Marked once, for the
// rest of this page's life; the next page starts unmarked.
let leaving = false;

export function markPageLeaving(): void {
  leaving = true;
}

export function isPageLeaving(): boolean {
  return leaving;
}
