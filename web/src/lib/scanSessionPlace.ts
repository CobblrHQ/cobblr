// Which of a session's items the strip's location control speaks for.
//
// WHERE a session's things go is a question about every pending item, not
// only the ones ready to file: a session whose rows all needed a look lost
// its location control ("File everything · needs review · open"), so the one
// thing you could settle about them had no door (#3884). The ready ones when
// there are any (File files exactly those), else every pending one.
export function sessionPlaceItems<T extends { status: string }>(items: readonly T[], ready: readonly T[]): T[] {
  return ready.length > 0 ? [...ready] : items.filter((it) => it.status === "pending");
}
