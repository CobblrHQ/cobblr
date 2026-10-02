// A picture that will not draw is said once, where someone can see it: on the
// console and in a count a test (or a support session) can read. Without it a
// broken photo on a grid looked exactly like a record with no photo, and the
// only report was a person noticing an empty tile.

const reported = new Set<string>();

function key(src: string): string {
  // One picture, however many tiles and sizes ask for it.
  const q = src.indexOf("?");
  return q === -1 ? src : src.slice(0, q);
}

/** Say once per picture that it would not load. */
export function reportBrokenPicture(src: string, reason: string): void {
  const k = key(src);
  if (reported.has(k)) return;
  reported.add(k);
  console.warn(`[photo] could not show ${k}: ${reason}`);
}

/** How many distinct pictures have failed in this page. */
export function brokenPictureCount(): number {
  return reported.size;
}

/** For tests. */
export function resetBrokenPictures(): void {
  reported.clear();
}
