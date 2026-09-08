// The prompt line for what screen the user is on.
//
// Its own file beside selection-line.ts, and for the same reason: a pure
// sentence-builder should be testable without dragging the router in behind
// it. It moved OUT of chat.ts because the route appended it to the prompt
// AFTER the builder had finished, which meant anything else building a prompt
// through the builder - the action bench - silently sent one without it. Asked
// "save this as a board", the bench's model had no "this" to save and answered
// in words; the app, which does send the line, has a screen to point at. That
// is a measurement missing a piece of the product, not a model miss.
//
// Now the builder owns the whole prompt and nobody appends to it; scripts/
// lint-one-system-prompt.ts keeps it that way.

/** Tell Cobb what screen the user is on, for situational relevance. Empty
 *  when there is no context. */
export function pageContextLine(context?: { label: string; summary?: string }): string {
  if (!context?.label) return "";
  const showing = context.summary ? ` Currently showing: ${context.summary}.` : "";
  return (
    `\n\nCURRENT VIEW: the user is looking at the "${context.label}" screen.${showing} ` +
    `Use this for situational relevance — you may lead with or reference what they're looking at — ` +
    `but still answer their ACTUAL question: if they ask about the whole workspace, answer workspace-wide, not just this screen.`
  );
}
