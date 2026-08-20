// Telling the model what the deterministic layer already worked out.
//
// The offer strip says "Tab to run this, free"; pressing enter instead sends
// the sentence to a model that has no idea any of that happened. It then works
// the problem from scratch — and can arrive somewhere worse than the answer
// that was sitting right there, or ask a question the offer had already
// answered.
//
// So it is told. As INFORMATION, not an instruction: the person chose the
// model over the offer, and a prompt that turns the offer into an order takes
// that choice back. The model may use it, ignore it, or say why it is doing
// something else.

export function suggestionLine(sug?: { template: string; summary: string; operations: number }): string {
  if (!sug?.template) return "";
  return (
    `\n\nALREADY WORKED OUT: this workspace can do "${sug.template}" without you — ` +
    `${sug.summary} (${sug.operations} change${sug.operations === 1 ? "" : "s"}). ` +
    `The user chose to ask you instead, so this is for information: if it is exactly what they asked for, ` +
    `you can say so and do the same thing rather than inventing a different one, and you already know what ` +
    `it found. If they meant something else, ignore it.`
  );
}
