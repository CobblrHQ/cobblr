// Where to land, and what to say, after a bundle is set up from a capture or a
// starter ("Create Filament Types", the one-shot starter, the post-modal
// commit). One rule for all three doors, so they cannot drift apart.
//
// A landing page carries its own one-time banner ("Filament Types is set up,
// 1 item filed from your capture. This is its home now."), driven by the
// ?created strip. Saying it a second time as a toast put the same sentence
// twice on a phone screen, and the toast sat on top of the very first row the
// person had just made (#3227 re-walk, 2026-09-21). So: a route means the
// banner speaks and the toast stays quiet; no route means nowhere to show a
// banner, and the toast is the only word.

export interface MaterializeResult {
  route?: string | null;
  label?: string | null;
  created: number;
}

export function materializeLanding(r: MaterializeResult): { to: string | null; toast: string | null } {
  const label = r.label ?? "bundle";
  const to = r.route
    ? `${r.route}${r.route.includes("?") ? "&" : "?"}created=${encodeURIComponent(r.label ?? "Your bundle")}&count=${r.created}`
    : null;
  return {
    to,
    toast: to ? null : `Created your ${label} with ${r.created} item${r.created === 1 ? "" : "s"}.`,
  };
}
