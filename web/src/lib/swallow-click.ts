// A drag ends where it began, on the thing that was pressed, and the browser
// then fires a click there. On a card whose click opens the record, a drop
// opened it. Swallow the one click that follows a drag, and only that one.
//
// The window is taken once, when the swallow is armed, and everything that
// touches it afterwards is guarded: its timer can fire after the page that
// armed it has gone (a test's document torn down after a drag), where a bare
// `window` no longer resolves, or resolves to a husk whose methods are gone
// ("w.removeEventListener is not a function", main's CI 2026-10-04). The
// returned function cancels it early (an unmount).
export function swallowNextClick(): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window;
  let t: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const stop = (ev: MouseEvent) => {
    // Finished but not removable (a husk window): never swallow a later click.
    if (finished) return;
    ev.stopPropagation();
    ev.preventDefault();
    done();
  };
  const done = () => {
    if (finished) return;
    finished = true;
    if (t !== undefined) clearTimeout(t);
    if (typeof w.removeEventListener === "function") w.removeEventListener("click", stop, true);
  };
  if (typeof w.addEventListener !== "function") return () => {};
  w.addEventListener("click", stop, true);
  t = setTimeout(done, 600);
  return done;
}
