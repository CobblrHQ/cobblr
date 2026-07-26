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

/** Raw battery byte -> volts.
 *
 *  HYPOTHESIS, not a datasheet: the observed values are 117, 128 and 153, which
 *  are not percentages. Read as volts x 32 they become 3.66 V, 4.00 V and
 *  4.78 V — a coherent 1S lithium cell plus a USB rail, and the 4.00 V reading
 *  came from a printer displaying 4 of 5 bars on its own screen, which is where
 *  a 1S cell sits at 4.00 V. One anchor point, so treat the number as
 *  approximate and keep the raw byte for recalibration. */
const VOLTS_PER_COUNT = 1 / 32;

/** Above a full 1S charge (4.2 V) the reading is the charger, not the cell. */
const CHARGING_VOLTS = 4.35;

/** Bar thresholds down a 1S lithium discharge curve. Coarse ON PURPOSE: the
 *  printers and their vendor apps show bars, so showing a percentage derived
 *  from a single-point voltage estimate would be inventing precision. */
const BAR_VOLTS = [3.55, 3.7, 3.82, 3.95, 4.1] as const;

export interface BatteryReading {
  /** The byte as received, so a future calibration can reinterpret it. */
  raw: number;
  volts: number;
  /** 0 to 5, matching the granularity the hardware itself displays. */
  bars: number;
  /** Reading sits above a full cell, i.e. running on external power. */
  charging: boolean;
}

export function readBattery(raw: number): BatteryReading {
  const volts = raw * VOLTS_PER_COUNT;
  const charging = volts >= CHARGING_VOLTS;
  // While charging the rail voltage says nothing about the cell, so report a
  // full bar count rather than a misleading one derived from the charger.
  let bars = charging ? BAR_VOLTS.length : 0;
  if (!charging) for (const v of BAR_VOLTS) if (volts >= v) bars++;
  return { raw, volts, bars, charging };
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
  return readBattery(raw);
}
