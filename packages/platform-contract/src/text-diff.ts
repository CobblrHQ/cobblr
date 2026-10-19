// A line diff of two texts (Myers' algorithm, O((N+M)·D)), in hunks with a
// few lines of context: what a person reads before they let a changed
// program run. Shared by the api, which stores nothing of it, and the web,
// which draws it.

export interface DiffLine { op: "same" | "add" | "del"; text: string; old: number | null; new: number | null }
export interface DiffHunk { lines: DiffLine[] }
export interface TextDiff { hunks: DiffHunk[]; added: number; removed: number; tooLarge: boolean }

const MAX_LINES = 20_000;
const MAX_EDITS = 4_000;

function editScript(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], offset: number, last: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length, y = b.length;
  for (let d = last; d > 0; d--) {
    const v = trace[d]!, k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; out.push({ op: "same", text: a[x]!, old: x + 1, new: y + 1 }); }
    if (x === prevX) { y--; out.push({ op: "add", text: b[y]!, old: null, new: y + 1 }); }
    else { x--; out.push({ op: "del", text: a[x]!, old: x + 1, new: null }); }
  }
  while (x > 0 && y > 0) { x--; y--; out.push({ op: "same", text: a[x]!, old: x + 1, new: y + 1 }); }
  return out.reverse();
}

const lines = (t: string) => (t === "" ? [] : t.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** The changes from `before` to `after`, grouped into hunks with `context`
 *  unchanged lines around each change. Too large to diff says so rather than
 *  pretending the texts are the same. */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const a = lines(before), b = lines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { hunks: [], added: 0, removed: 0, tooLarge: true };
  const script = editScript(a, b);
  if (!script) return { hunks: [], added: 0, removed: 0, tooLarge: true };
  const changed = script.map((l, i) => (l.op === "same" ? -1 : i)).filter((i) => i >= 0);
  const hunks: DiffHunk[] = [];
  let start = -1, end = -1;
  for (const i of changed) {
    if (start >= 0 && i - context <= end + context) { end = i; continue; }
    if (start >= 0) hunks.push({ lines: script.slice(Math.max(0, start - context), Math.min(script.length, end + context + 1)) });
    start = end = i;
  }
  if (start >= 0) hunks.push({ lines: script.slice(Math.max(0, start - context), Math.min(script.length, end + context + 1)) });
  return { hunks, added: script.filter((l) => l.op === "add").length, removed: script.filter((l) => l.op === "del").length, tooLarge: false };
}
