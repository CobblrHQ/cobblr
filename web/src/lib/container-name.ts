// The name a new container is saved under. A bare word ("Bin", "Drawer") gets
// the workspace's next container number, so "Bin" becomes "Bin 19"; anything
// more is the person's own name for it and is saved as typed (#8883: "Bin 1a
// Wood screws" was saved as "Bin 1a Wood screws 1").

const BARE_WORD = /^\p{L}+$/u;

/** One more than the highest number in any container's name, wherever it
 *  stands: "Bin 4 Hinges and brackets" holds 4 as surely as "Bin 4" does. */
export function nextContainerNumber(all: ReadonlyArray<{ kind: string; name: string | null }>): number {
  let max = 0;
  for (const l of all) {
    if (l.kind !== "container") continue;
    for (const m of (l.name ?? "").matchAll(/\d+/g)) max = Math.max(max, parseInt(m[0], 10));
  }
  return max + 1;
}

export function containerName(typed: string, kind: string, all: ReadonlyArray<{ kind: string; name: string | null }>): string {
  const name = typed.trim();
  return kind === "container" && BARE_WORD.test(name) ? `${name} ${nextContainerNumber(all)}` : name;
}
