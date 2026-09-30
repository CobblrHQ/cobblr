// A model's size, read from its own bytes, so a person's STL can be matched
// to a printer it fits before anything is sliced.
//
// Binary STL: an 80-byte header, a uint32 triangle count, then 50 bytes per
// triangle (normal, three vertices, attribute). ASCII STL: `vertex x y z`
// lines. Anything else (a 3MF is a zip, a STEP is text of another kind) is
// not read here and answers null: the size is then not known, which the
// printer choice says rather than guesses.

export type Size = [number, number, number];

export function stlSize(bytes: Uint8Array): Size | null {
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (count > 0 && 84 + count * 50 === bytes.length) return binarySize(view, count);
  }
  return asciiSize(new TextDecoder("latin1").decode(bytes));
}

function binarySize(view: DataView, count: number): Size | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const x = view.getFloat32(base + v * 12 + a * 4, true);
        if (!Number.isFinite(x)) return null;
        if (x < min[a]!) min[a] = x;
        if (x > max[a]!) max[a] = x;
      }
    }
  }
  return sizeOf(min, max);
}

function asciiSize(text: string): Size | null {
  if (!/^\s*solid\b/i.test(text)) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let seen = 0;
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
    const p = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!p.every(Number.isFinite)) return null;
    for (let a = 0; a < 3; a++) {
      if (p[a]! < min[a]!) min[a] = p[a]!;
      if (p[a]! > max[a]!) max[a] = p[a]!;
    }
    seen++;
  }
  return seen ? sizeOf(min, max) : null;
}

function sizeOf(min: number[], max: number[]): Size | null {
  const s = [0, 1, 2].map((a) => Math.round((max[a]! - min[a]!) * 100) / 100) as Size;
  return s.every((v) => Number.isFinite(v) && v >= 0) ? s : null;
}

/** A size from a design service's model report (`report.size_mm`). */
export function reportedSize(report: unknown): Size | null {
  const raw = (report as { size_mm?: unknown } | null)?.size_mm;
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const s = raw.map(Number);
  return s.every((v) => Number.isFinite(v) && v > 0) ? (s as Size) : null;
}
