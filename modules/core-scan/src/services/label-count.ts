// How many a pack or case label says it holds, read from the words printed on
// it (#3729). No model: the photo read already transcribes the label into its
// observation ("a white shipping label ... quantity contained 3"), and these
// are the ways a count is printed.
//
// A count, never a size: "3.5 oz", "100 ft", "6127" (a lot number) and a
// weight are not how many things there are. Two or more only: a label saying
// "1" says nothing a single scan did not.

const PHRASES: RegExp[] = [
  /\bquantity\s+contained[:\s]+(\d{1,3})\b/i,
  /\b(?:qty|quantity)\s*[:#=]?\s*(\d{1,3})\b(?!\s*(?:oz|g|kg|lb|lbs|ml|l|ft|m|cm|mm|in|yd|%))/i,
  /\bcase\s+of\s+(\d{1,3})\b/i,
  /\bpack\s+of\s+(\d{1,3})\b/i,
  /\b(\d{1,3})\s*-?\s*(?:ct|count|pk|pack|pcs|pieces|units|skeins|per\s+case)\b/i,
];

/** The count a label states, or null. Reads the observation first (what was
 *  printed), then the name. */
export function labelCountOf(...texts: Array<string | null | undefined>): number | null {
  for (const text of texts) {
    if (!text) continue;
    for (const re of PHRASES) {
      const m = re.exec(text);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 2 && n <= 500) return n;
    }
  }
  return null;
}
