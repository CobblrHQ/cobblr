// Telling the model what the deterministic layer already worked out.
//
// The order of authority here is deliberate, and it is the product's answer to
// a weak model. The free-tier model hallucinates: asked to move five tea items
// it created copies of two, then on another day proposed deleting them. The
// no-AI path had not read that sentence at all, and once it could, the right
// division of labour was obvious - CODE recognises the request and plans it,
// exactly and every time; the MODEL confirms that plan, says it in a sentence
// a person wants to read, and handles whatever else was in the same message.
// The model is the narrator of a deterministic result, not a second opinion
// on it (owner, 2026-09-09).
//
// So this is not "for information". When the plan matches what was asked, it
// IS the answer, and the model runs that plan rather than working the problem
// from scratch and arriving somewhere worse. The escape stays: if the person
// clearly meant something the plan does not cover, the model says so.

export function suggestionLine(sug?: { template: string; summary: string; operations: number }): string {
  if (!sug?.template) return "";
  const n = sug.operations;
  return (
    `\n\nWORKED OUT ALREADY, IN CODE: this workspace read that request as "${sug.template}" and planned it exactly - ` +
    `${sug.summary} (${n} change${n === 1 ? "" : "s"}). This plan came from looking at the records, not from guessing, ` +
    `and it is the answer to that part of the message: run THIS plan (the same records, the same action), do not ` +
    `reinvent it, and do not create, delete or rename anything it did not. Say what it does in plain words, and ` +
    `handle anything ELSE the person asked for in the same message. Only if they clearly meant something this plan ` +
    `does not cover, say what the plan would have done and ask.`
  );
}
