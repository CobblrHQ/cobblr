// Turning what a person SAID into the thing they meant.
//
// Lives in the contract because two surfaces already need it and a third will:
// nav sections (core-presentation), field defs (the kernel's edit-field /
// remove-field), and anything else the assistant addresses by its label rather
// than its id. A second copy of this would be a second answer to "did they mean
// this one?", and the two would drift on the day one of them learned something.
//
// Pure and dependency-free, because it is the part that decides whether an
// assistant action is useful or dangerous: acting on the wrong thing is a change
// someone has to notice before they can undo it.

/** Split "Spices, Tea and Herbs" into the three names a person meant. */
export function splitNames(raw: string): string[] {
  return String(raw ?? "")
    .split(/,| and /i)
    .map((s) => s.trim().replace(/^["“']|["”']$/g, ""))
    .filter(Boolean);
}

/** Match a said name to one of `items` by its label. Exact first, then
 *  case-insensitive, then a unique prefix — and NEVER a guess between two
 *  candidates: an ambiguous answer is returned so the caller can ask. */
export function matchByLabel<T extends { label: string }>(
  said: string,
  items: readonly T[],
): T | { ambiguous: T[] } | null {
  const exact = items.filter((e) => e.label === said);
  if (exact.length === 1) return exact[0]!;
  const ci = items.filter((e) => e.label.toLowerCase() === said.toLowerCase());
  if (ci.length === 1) return ci[0]!;
  if (ci.length > 1) return { ambiguous: ci };
  const starts = items.filter((e) => e.label.toLowerCase().startsWith(said.toLowerCase()));
  if (starts.length === 1) return starts[0]!;
  if (starts.length > 1) return { ambiguous: starts };
  return null;
}
