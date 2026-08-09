// The decidable parts of "Move to...", split out of the modal so they can be
// tested. This repo has no DOM-test setup (every test here is pure logic), and
// adding one to cover two decisions would be a worse trade than making the two
// decisions testable.
//
// Both are places where a quiet mistake is expensive: offering the instance the
// record is already in reads as a broken menu, and sending the wrong carry list
// either drops a field's label or reshapes the destination for the whole
// workspace.

export interface InstanceOption {
  module_name: string;
  instance_name: string;
  display_name: string;
  is_default?: boolean;
  /** False when the owning module registered no mover. Older API responses
   *  omit it, which must read as "allowed" rather than "hidden": a missing
   *  field should never silently empty the menu. */
  movable?: boolean;
}

/** Where these records may go: siblings in the same module, excluding the one
 *  they are in, and only where the module can actually move them. */
export function moveDestinations(
  items: InstanceOption[],
  fromInstance: string,
): InstanceOption[] {
  // This is one module's INSTANCE list, not the entity-kind registry, and
  // excluding the current instance is the question being asked.
  // registry-filter-ok: siblings of the instance the records are in
  return items.filter((i) => i.instance_name !== fromInstance && i.movable !== false);
}

/** The field names to carry, from the checkbox state. Absent means ticked,
 *  because the preview defaults every offered field to on: a field the user
 *  never touched must still come along. */
export function carryFieldNames(
  offered: Array<{ name: string }>,
  checked: Record<string, boolean>,
): string[] {
  return offered.map((f) => f.name).filter((name) => checked[name] !== false);
}
