// How a receipt session's date was read, in words a person can check
// against the paper (#2917). The header shows the date with the month
// spelled out, so a wrong reading is visible at a glance; this is the line
// under the pointer that says which way round a numeric date went and why.
export interface DateReading {
  date_convention?: string | null;
  date_decided_by?: string | null;
  date_printed?: string | null;
}

export function receiptDateWords(r: DateReading | null | undefined): string | null {
  if (!r?.date_printed) return null;
  const order = r.date_convention === "mdy" ? "month/day" : r.date_convention === "dmy" ? "day/month" : null;
  switch (r.date_decided_by) {
    case "unambiguous":
      return order ? `Printed ${r.date_printed}: only ${order} reads as a date.` : `Printed ${r.date_printed}.`;
    case "receipt":
      return `Printed ${r.date_printed}, read ${order} from the receipt's own currency and prices.`;
    case "workspace":
      return `Printed ${r.date_printed}, read ${order} as this workspace's other receipts are.`;
    case "nearest-past":
      return `Printed ${r.date_printed}, read ${order} as the most recent day it could mean. If that is wrong, edit the date on a line.`;
    case "model":
      return `Read as the AI printed it: ${r.date_printed}.`;
    default:
      return `Printed ${r.date_printed}.`;
  }
}
