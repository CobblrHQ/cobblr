// What a print's confirmation says, counted in labels on paper (#7594). A row
// queued at three copies is three labels: the preview, the toolbar's "Print 3"
// and the rendered job all say three, so "Sent 1" read as a print that lost two.
import type { SentLabels } from "./api";

/** The labels a send puts on paper: every copy of every row. */
export function labelsIn(sent: SentLabels): number {
  return sent.items.reduce((n, i) => n + i.qty, 0);
}

const labels = (n: number) => `${n} label${n === 1 ? "" : "s"}`;

/** The browser's print dialog has opened on this sheet. */
export function printingWords(sent: SentLabels): string {
  return `Printing ${labels(labelsIn(sent))}. Mark printed once the paper looks right?`;
}

/** A network printer has been sent this job. */
export function sentWords(sent: SentLabels, printer: string): string {
  return `Sent ${labels(labelsIn(sent))} to ${printer}. Mark printed once it looks right?`;
}
