// Decoding what a thermal printer says about itself.
//
// Pure byte-in / values-out, deliberately with no transport and no browser API,
// because three different callers need it: the Web Serial path, the Bluetooth
// path if a model ever answers over GATT, and the edge bridge. Protocol
// knowledge belongs next to tspl.ts, not inside one transport.
//
// PROVENANCE: decoded from HCI captures of two printers' own vendor apps
// (2026-07-26). Everything here is pinned by a test against those real bytes.

// The reply reads cleanly as pairs behind a declared length:
//
//   <len:2> <tag,value>*  <checksum>
//   0x01=34  0x03=0  0x03=1  0x06=18  0x15=80  0x0f=50     <- PM240, 50x80 roll
//   0x01=34  0x03=0  0x03=1  0x06=18  0x15=30  0x0f=40     <- PM240, 40x30 roll
//   0x01=34  0x03=0  0x03=1  0x06=18  0x15=30  0x0f=50     <- PM220S, 50x30 roll
//
// Treat the tag/value reading as a WORKING HYPOTHESIS from three captures, not a
// datasheet: 0x03 appears twice, which real TLV rarely allows, so these may just
// be positional bytes. The parse survives either interpretation because it
// requires BOTH dimension tags in plausible range before believing anything.
//
// History, kept honest: the first parser read fixed offsets 11/13, and — worth
// admitting — those offsets actually decode every capture above correctly (the
// tail difference sits AFTER them; an earlier comment here claimed otherwise).
// Their real weaknesses are leading bytes (RFCOMM credit bytes shift everything)
// and any reply that reorders fields. The second parser anchored on a 0x12,0x15
// marker, which only exists because tag 0x06 happens to carry the value 0x12 —
// a printer reporting a different value there would have broken it, and a chance
// 0x12,0x15 inside raster could satisfy it. This version depends on neither.

/** Label height in mm, along the feed direction. */
const TAG_HEIGHT_MM = 0x15;
/** Media width in mm, across the head. */
const TAG_WIDTH_MM = 0x0f;

/** A plausible label edge in mm. Anything outside this is a garbled read, and
 *  discarding it beats configuring a nonsense media size. */
const MIN_MM = 10;
const MAX_MM = 120;

/** Sane bounds for the declared payload length, used to find the frame start in
 *  a buffer that may carry leading noise (serial has no message framing). */
const MIN_PAYLOAD = 4;
const MAX_PAYLOAD = 64;

export interface MediaReading {
  widthMm: number;
  heightMm: number;
}

/** Read the tag/value pairs out of one candidate frame. */
function fieldsAt(bytes: Uint8Array, start: number, declared: number): Map<number, number> {
  const fields = new Map<number, number>();
  // start = the flag byte; start+1 = length; pairs begin at start+2.
  const end = Math.min(start + 2 + declared, bytes.length);
  for (let i = start + 2; i + 1 < end; i += 2) fields.set(bytes[i]!, bytes[i + 1]!);
  return fields;
}

/** Pull the loaded roll's dimensions out of a status reply.
 *
 *  Returns null when the reply carries no plausible reading. That is a normal,
 *  meaningful outcome rather than an error: a printer with an UNCODED roll
 *  reports its size as unknown instead of repeating a stale one, which is
 *  exactly what makes the reading trustworthy when it is present. */
export function parseMediaReading(bytes: Uint8Array): MediaReading | null {
  for (let i = 0; i + 3 < bytes.length; i++) {
    // The LENGTH IS THE LOW BYTE; the high byte carries flags. Reading the pair
    // as one 16-bit length worked only because every capture happened to have
    // 0x00 there — until a probe caught a reply while the printer was on the
    // charger, which came back 0x20 0x0c (battery 0x99 = 4.78V, the USB rail).
    // 0x200c fails any sane range check, so the roll silently failed to decode
    // whenever the printer was plugged in.
    const declared = bytes[i + 1]!;
    if (declared < MIN_PAYLOAD || declared > MAX_PAYLOAD) continue;
    const fields = fieldsAt(bytes, i, declared);
    const heightMm = fields.get(TAG_HEIGHT_MM);
    const widthMm = fields.get(TAG_WIDTH_MM);
    if (heightMm === undefined || widthMm === undefined) continue;
    // Requiring BOTH tags in range is what makes scanning for the frame start
    // safe: random bytes rarely satisfy both at a consistent pair alignment.
    if (heightMm < MIN_MM || heightMm > MAX_MM) continue;
    if (widthMm < MIN_MM || widthMm > MAX_MM) continue;
    return { widthMm, heightMm };
  }
  return null;
}

/** Battery as a fraction of the highest reading ever observed.
 *
 *  NOT VOLTS. An earlier version read the byte as volts x 32, which made 0x99
 *  come out at 4.78V and get labelled "charging" — until the owner confirmed the
 *  printer was on BATTERY and merely freshly charged. 4.78V is impossible for a
 *  1S cell, so the mapping was wrong and the charging label was invented on top
 *  of it. A fully charged printer was being shown as plugged in.
 *
 *  What is actually known, from hardware:
 *    0x99 (153) — freshly charged, unplugged. Treated as full.
 *    0x80 (128) — a printer displaying 4 of 5 bars on its own screen.
 *    0x75 (117) — the same printer lower down.
 *  round(raw / 153 * 5) puts 153 at 5 bars and 128 at 4, matching the one
 *  hardware anchor there is.
 *
 *  CHARGE STATE comes from the byte AFTER the level, not from the level itself:
 *  the same printer at the same level 0x99 reported 0x00 unplugged and 0x01 the
 *  moment it was plugged in. Every earlier capture agrees (0x75 00, 0x80 00,
 *  both on battery). An earlier version inferred charging from an impossible
 *  voltage instead and labelled a full battery as plugged in. The raw bytes are
 *  always carried so a better scale can replace this without new captures. */
const FULL_RAW = 0x99;
const BARS = 5;

export interface BatteryReading {
  /** The byte as received, so a future calibration can reinterpret it without
   *  needing new hardware captures. */
  raw: number;
  /** 0..1 against the fullest reading ever observed (0x99, from a freshly
   *  charged printer that was not plugged in). */
  fraction: number;
  /** 0 to 5, matching the granularity the hardware itself displays. */
  bars: number;
  /** Running on external power. Read from the flag byte that follows the level,
   *  verified by plugging the printer in and watching only that byte change. */
  charging: boolean;
}

export function readBattery(raw: number, chargeFlag = 0): BatteryReading {
  const fraction = Math.max(0, Math.min(1, raw / FULL_RAW));
  return { raw, fraction, bars: Math.round(fraction * BARS), charging: chargeFlag === 1 };
}

/** Find `BATTERY <byte>` in a reply. The level is a raw byte, not ASCII digits,
 *  so it is read positionally after the label rather than parsed as a number. */
export function parseBatteryReply(bytes: Uint8Array): BatteryReading | null {
  const label = "BATTERY ";
  const text = new TextDecoder("latin1").decode(bytes);
  const at = text.indexOf(label);
  if (at < 0) return null;
  const raw = bytes[at + label.length];
  if (raw === undefined) return null;
  // The flag byte may be absent on a truncated read; absent means "unknown",
  // which we report as not charging rather than guessing.
  return readBattery(raw, bytes[at + label.length + 1] ?? 0);
}
