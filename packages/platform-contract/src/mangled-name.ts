// A file name whose UTF-8 bytes an upload read as Latin-1: "café.txt" kept as "cafÃ©.txt". Every upload shared that
// one door, so each place that kept the name repairs it with this one rule.

/** The name it should have been, or null when this isn't UTF-8 read as Latin-1. A real "é" alone isn't valid UTF-8
 *  once read back as a byte, so a correct name in French or German is left alone. */
export function mangledNameRepaired(name: string): string | null {
  if (!/[\u0080-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(name)) return null;
  const bytes = Buffer.from(name, "latin1");
  const fixed = bytes.toString("utf8");
  // Bytes that aren't valid UTF-8 don't survive the round trip: this was never a mangled name.
  return Buffer.from(fixed, "utf8").equals(bytes) && fixed !== name ? fixed : null;
}
