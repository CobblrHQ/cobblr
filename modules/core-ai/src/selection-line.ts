// The prompt line for what the user is pointing at.
//
// Its own file, with no imports: a pure sentence-builder should be testable
// without dragging in the router, the tool registry and everything they pull
// along behind them. (CI builds no workspace package before unit tests, so a
// test that reaches through api/chat.ts cannot even load.)

/** What the user has selected, for the prompt.
 *
 *  The point of ids: a selection Cobb can only READ is a description, and he
 *  will go looking for the things again by name. With the ids he can act on
 *  exactly what was ticked — which is the difference between "delete
 *  duplicates" searching the workspace and it meaning THESE twelve racks. */
export function selectionLine(sel?: {
  label: string;
  kind?: string;
  ids?: string[];
  text?: string;
}): string {
  if (!sel?.label) return "";
  const which = sel.ids?.length
    ? ` Their ids are: ${sel.ids.slice(0, 200).join(", ")}.`
    : "";
  const named = sel.text ? ` They are: ${sel.text}.` : "";
  const kind = sel.kind ? ` (${sel.kind})` : "";
  return (
    `\n\nSELECTED: the user has picked out "${sel.label}"${kind} on that screen.${named}${which} ` +
    `When they say "these", "them", "the selected ones" or say nothing at all about WHICH, they mean exactly this set — ` +
    `act on it directly rather than searching for it again. If they clearly mean something else, follow what they said.`
  );
}
