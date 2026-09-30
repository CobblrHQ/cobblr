// A drag ends where it began, on the thing that was pressed, and the browser
// then fires a click there. On a card whose click opens the record, a drop
// opened it. Swallow the one click that follows a drag, and only that one.
//
// The window is taken once, when the swallow is armed: its timer can fire after
// the page that armed it has gone (a test's document torn down after a drag),
// where a bare `window` no longer resolves.
export function swallowNextClick(): void {
  const w = window;
  const stop = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    done();
  };
  const done = () => {
    w.removeEventListener("click", stop, true);
    w.clearTimeout(t);
  };
  w.addEventListener("click", stop, true);
  const t = w.setTimeout(done, 600);
}
