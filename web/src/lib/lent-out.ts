// What is out right now, by who has it: the Lent out page's read of GET /loans
// (record-loans.md). Overdue first, then the soonest due, then no due day, so
// the person chasing returns reads the list top-down. A day earlier than today
// is overdue, so ordering by due day already puts the late holders first.
import { loanOverdue } from "@cobblr/platform-contract/loan";

export interface LentRow {
  kind: string;
  id: string;
  title: string;
  said: string;
  holder: string;
  holder_id: string | null;
  reason: string | null;
  since: string;
  due_back: string | null;
  note: string | null;
}

export interface HolderGroup {
  holder: string;
  overdue: number;
  rows: LentRow[];
}

const byDue = (a: LentRow, b: LentRow) => (a.due_back ?? "9999-12-31").localeCompare(b.due_back ?? "9999-12-31") || a.title.localeCompare(b.title);

/** Everyone holding something, the people with something overdue first. Every row appears once. */
export function groupLentByHolder(rows: readonly LentRow[], today: string): HolderGroup[] {
  const groups = new Map<string, HolderGroup>();
  for (const r of rows) {
    const key = r.holder_id ?? r.holder.trim().toLowerCase();
    const g = groups.get(key) ?? { holder: r.holder, overdue: 0, rows: [] };
    g.rows.push(r);
    if (loanOverdue(r, today)) g.overdue++;
    groups.set(key, g);
  }
  for (const g of groups.values()) g.rows.sort(byDue);
  return [...groups.values()].sort((a, b) => byDue(a.rows[0]!, b.rows[0]!) || a.holder.localeCompare(b.holder));
}
