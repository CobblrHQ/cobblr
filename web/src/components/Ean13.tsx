// An EAN-13 barcode, drawn as SVG.
//
// Exists so a screen can hand somebody something to SCAN. The sandbox's first
// run uses it: pair your phone, point it at this, and watch a real product come
// back named with its photo. Telling a visitor "go and find a barcode" asks
// them to leave; printing one asks them to point.
//
// No dependency. EAN-13 is 95 modules of fixed structure and three lookup
// tables, which is less code than wiring a barcode library into the bundle, and
// this file cannot drift with one.
//
// Structure: 101 guard, six left digits (7 modules each, parity chosen by the
// FIRST digit), 01010 centre guard, six right digits, 101 guard.

/** Left-hand odd parity. */
const L = ["0001101", "0011001", "0010011", "0111101", "0100011",
           "0110001", "0101111", "0111011", "0110111", "0001011"];
/** Left-hand even parity. */
const G = ["0100111", "0110011", "0011011", "0100001", "0011101",
           "0111001", "0000101", "0010001", "0001001", "0010111"];
/** Right-hand, always even parity. */
const R = ["1110010", "1100110", "1101100", "1000010", "1011100",
           "1001110", "1010000", "1000100", "1001000", "1110100"];
/** Which of the left six digits use G, keyed by the first digit. */
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
                "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The 95-module bit string for a 13-digit code. Exported for the test, which
 *  decodes it back rather than comparing against a second copy of the tables. */
export function ean13Modules(code: string): string {
  const d = code.split("").map(Number);
  if (d.length !== 13 || d.some((n) => Number.isNaN(n))) throw new Error("EAN-13 needs 13 digits");
  const parity = PARITY[d[0]!]!;
  let out = "101";
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === "L" ? L : G)[d[i]!]!;
  out += "01010";
  for (let i = 7; i <= 12; i++) out += R[d[i]!]!;
  return out + "101";
}

/** The check digit EAN-13 expects for the first 12 of a code. */
export function ean13CheckDigit(first12: string): number {
  const d = first12.split("").map(Number);
  const sum = d.reduce((a, n, i) => a + n * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export function Ean13({ code, height = 64 }: { code: string; height?: number }) {
  let modules: string;
  try {
    modules = ean13Modules(code);
  } catch {
    return null;
  }
  const unit = 2;
  const quiet = 11 * unit; // the mandated quiet zone; scanners need it to lock on
  const width = quiet * 2 + modules.length * unit;
  // The guard bars run longer than the data bars, which is what the eye (and
  // some scanners) use to find the ends.
  const isGuard = (i: number) => i < 3 || (i >= 45 && i < 50) || i >= 92;
  const bars: Array<{ x: number; h: number }> = [];
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== "1") continue;
    bars.push({ x: quiet + i * unit, h: isGuard(i) ? height + 6 : height });
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height + 20}`}
      width={width}
      height={height + 20}
      role="img"
      aria-label={`Barcode ${code}`}
      className="max-w-full h-auto"
    >
      {/* White behind it, always: a barcode on a tinted card is a barcode that
          does not scan on half the phones that try. */}
      <rect x="0" y="0" width={width} height={height + 20} fill="#ffffff" />
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={2} width={unit} height={b.h} fill="#000000" />
      ))}
      <text
        x={width / 2}
        y={height + 17}
        textAnchor="middle"
        fontSize="11"
        fontFamily="monospace"
        fill="#000000"
      >
        {code}
      </text>
    </svg>
  );
}
