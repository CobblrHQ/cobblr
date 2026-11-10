// The way back for a part taken out of a build (ContentsPanel), as the
// placement door will take it.
//
// The door guards a move (expected: where the thing should still be) only for
// a whole record: a guarded move that also splits (qty) is refused outright
// ("a guarded move keeps the whole record distinct"). The take-out's Undo sent
// both, so it was refused every time, with or without a teammate's move since.
//
// A take-out that moved the record itself puts the whole record back,
// guarded, so a teammate's later move is kept. One whose part joined spares
// already kept there (the door answers a different record) takes that many
// back out of them, a split the door cannot guard.
type Ref = { kind: string; id: string };

export function takeOutUndoBody(a: { took: Ref; placed: Ref; container: Ref; to: Ref | null; qty: number | null }): Record<string, unknown> {
  const sameRecord = a.placed.kind === a.took.kind && a.placed.id === a.took.id;
  if (sameRecord) return { containee: a.placed, container: a.container, expected: { container: a.to } };
  return { containee: a.placed, container: a.container, ...(a.qty ? { qty: a.qty } : {}) };
}
