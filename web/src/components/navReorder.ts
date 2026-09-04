// What a nav drag MEANS, apart from the pointer that produced it.
//
// The sidebar shows two levels: tops, and the children indented under a
// heading or a module. Both are draggable, and they are not the same move:
// dragging a top reorders the tops, dragging a child reorders that child among
// ITS OWN SIBLINGS and must not touch anything else.
//
// It used to be one level. The group's drag listeners were spread over the
// whole block, so grabbing a child started a drag of the parent: "trying to
// drag the Groceries child here is moving the entire block. I just wanted to
// rearrange Groceries within the parent block" (2026-09-04). And the saved
// order only ever listed tops, so even once a child could be grabbed there was
// nothing for the move to be written into.
//
// The saved order is ONE flat list of names, oldest-first, which the nav reads
// at both levels: `orderTops` places a heading at its best-placed member's
// slot, and each group's children are sorted by the same list. So the whole
// tree is written back as a flat sequence - every top followed by its own
// children - and both levels stay consistent by construction rather than by
// two functions agreeing.

/** A top and the children rendered under it, in the order they appear now. */
export interface NavBranch {
  name: string;
  children: string[];
}

/** Move `moved` to where `over` sits, within the one list that holds them.
 *
 * Returns the new flat order, or null when the move is not one we make: an
 * unknown name, a no-op, or a child dropped onto something in another branch.
 * Null means "write nothing" - a drag that would rearrange somebody else's
 * group is a mis-drop, not an instruction.
 */
export function reorderNav(branches: NavBranch[], moved: string, over: string): string[] | null {
  if (!moved || moved === over) return null;

  const flatten = (bs: NavBranch[]): string[] => bs.flatMap((b) => [b.name, ...b.children]);
  const topIndex = branches.findIndex((b) => b.name === moved);

  // A TOP moved: reorder the branches, children riding along with their parent.
  if (topIndex >= 0) {
    const overTop = branches.findIndex((b) => b.name === over);
    // Dropped onto a child: land beside that child's parent, which is what the
    // pointer was over as far as the top level is concerned.
    const target = overTop >= 0 ? overTop : branches.findIndex((b) => b.children.includes(over));
    if (target < 0 || target === topIndex) return null;
    const next = [...branches];
    const [b] = next.splice(topIndex, 1);
    next.splice(target, 0, b!);
    return flatten(next);
  }

  // A CHILD moved: only within its own branch.
  const from = branches.findIndex((b) => b.children.includes(moved));
  if (from < 0) return null;
  const branch = branches[from]!;
  const to = branch.children.indexOf(over);
  // Dropped on its own parent → to the top of that parent's list. Dropped on
  // anything outside this branch → not a move we make.
  const target = to >= 0 ? to : over === branch.name ? 0 : -1;
  if (target < 0) return null;
  const kids = [...branch.children];
  const at = kids.indexOf(moved);
  if (at === target) return null;
  kids.splice(at, 1);
  kids.splice(target, 0, moved);
  const next = [...branches];
  next[from] = { ...branch, children: kids };
  return flatten(next);
}
