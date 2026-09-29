// One way to read a name as a run of places: "Drawer 1-3" is Drawer 1,
// Drawer 2 and Drawer 3. Every form that makes places reads it the same, so
// the floor plan and the list never disagree about what a name means
// (scripts/capabilities.ts holds it to one owner).

// Parses a name like "Drawer 1-3" → { names: ["Drawer 1","Drawer 2",
// "Drawer 3"], preview: "…" }. Returns null when the input isn't a
// numeric range, when start > end, or when the range exceeds the
// 50-row safety cap. Accepts hyphen and en-dash; tolerates extra
// whitespace.
const RANGE_RE = /^(.*?)\s*(\d+)\s*[-–]\s*(\d+)\s*$/;
const MAX_RANGE = 50;

export function parseRange(raw: string): { names: string[]; prefix: string; preview: string } | null {
  const m = raw.match(RANGE_RE);
  if (!m) return null;
  const prefix = (m[1] ?? "").trim();
  const start = Number(m[2]);
  const end = Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) return null;
  const count = end - start + 1;
  if (count < 2 || count > MAX_RANGE) return null;
  const names: string[] = [];
  for (let n = start; n <= end; n++) {
    names.push(prefix ? `${prefix} ${n}` : String(n));
  }
  const preview =
    names.length <= 4
      ? names.join(", ")
      : `${names[0]}, ${names[1]}, …, ${names[names.length - 1]}`;
  return { names, prefix, preview };
}
