// Printing labels over a SERIAL port from the browser (Web Serial).
//
// WHY THIS EXISTS: some label printers are Bluetooth CLASSIC (SPP/RFCOMM), not
// BLE. The TYPONOS PM240 is one — an HCI capture of its own app showed it speaks
// plain TSPL, the dialect we already generate, but over an RFCOMM serial link.
// Its BLE GATT tree is a decoy that accepts writes and does nothing, which is why
// roughly ninety Web Bluetooth probe combinations all failed: a browser cannot
// reach Bluetooth Classic at all. The device dictates the API — BLE gets Web
// Bluetooth, Classic SPP gets Web Serial.
//
// THE ENCODER IS SHARED, DELIBERATELY. renderLabelBitmap + encodeForPrinter take
// a bitmap and settings and return bytes; they know nothing about transport. So a
// serial printer reuses the exact TSPL/Phomemo output a Bluetooth one gets, and a
// future edge-bridge transport is a third caller of the same two functions rather
// than a third copy of the label pipeline.
//
// Chrome/Edge on desktop only — Web Serial does not exist on Android or iOS,
// which is the mirror of Bluetooth's own limit and must be said plainly rather
// than appear broken.

import { renderLabelBitmap, encodeForPrinter, type BluetoothPrinterSettings, type LabelContent } from "./bluetooth-label.js";
import { effectiveFootprint } from "./bluetooth-label.js";
import { setPrintProgress } from "./print-progress.js";
import { mmToDots, parseMediaReading, parseBatteryReply, type BatteryReading } from "@cobblr/thermal-print";

// Web Serial is not in TypeScript's DOM lib, so declare the slice we use — the
// same approach ble.ts takes for Web Bluetooth.
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly writable: WritableStream<Uint8Array> | null;
  readonly readable: ReadableStream<Uint8Array> | null;
  // NOTE: for a Bluetooth serial port these are undefined — Web Serial does NOT
  // expose the port's name or path to the page. So a printer cannot be
  // identified by "PM240" the way a Bluetooth device can; it has to be ASKED.
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike {
  requestPort(options?: { filters?: unknown[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

function serial(): SerialLike {
  const s = (navigator as unknown as { serial?: SerialLike }).serial;
  if (!s) throw new Error(NO_WEB_SERIAL);
  return s;
}

export function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export const NO_WEB_SERIAL =
  "This browser has no Web Serial. Use Chrome or Edge on a desktop computer. " +
  "Phones and tablets cannot drive a serial printer from a web page.";

/** Baud is nominal over Bluetooth SPP (the link negotiates its own rate), but the
 *  API requires a value and a wrong one is harmless here. */
const BAUD = 115200;

/** Bytes per write. Serial has no 512-byte GATT ceiling, but a Bluetooth SPP link
 *  still buffers, and a 10 KB raster shoved in one call can overrun a cheap
 *  printer's receive buffer and truncate the label. */
const CHUNK = 1024;
const PACE_MS = 8;

export interface SerialSession {
  port: SerialPortLike;
  /** Open ports cannot be re-opened; the session owns the lifecycle. */
  opened: boolean;
}

// One held session, mirroring the Bluetooth path: a person printing labels one at
// a time must not pay a port prompt (which needs a user gesture) per label.
let held: SerialSession | null = null;

export function heldSerialPrinterOpen(): boolean {
  return !!held?.opened;
}

export async function releaseHeldSerialPrinter(): Promise<void> {
  if (!held) return;
  try {
    if (held.opened) await held.port.close();
  } catch {
    /* already gone */
  }
  held = null;
}

/** True when the port already has streams, i.e. it is open.
 *
 *  Web Serial gives no `isOpen`; a live port is one with readable/writable
 *  streams attached. */
function portIsOpen(port: SerialPortLike): boolean {
  return !!(port.readable ?? port.writable);
}

/** Open the port unless it already is.
 *
 *  Calling open() on an open port throws "The port is already open" — which for
 *  us is not a failure, it is the state we were trying to reach. This bit for
 *  real: Check (or an earlier connect) leaves the port open, then choosing that
 *  same port in the chooser threw and the whole connect flow died with an error
 *  that reads like the printer's fault. */
async function ensureOpen(port: SerialPortLike): Promise<void> {
  if (portIsOpen(port)) return;
  try {
    await port.open({ baudRate: BAUD });
  } catch (e) {
    // Same condition, lost race: another handler opened it between the check
    // and the call. Still not a failure.
    if (/already open/i.test(e instanceof Error ? e.message : String(e))) return;
    throw e;
  }
}

/** Show the port chooser. REQUIRES a user gesture in the call stack, like the
 *  Bluetooth chooser. A Bluetooth-Classic printer appears here once the OS has
 *  paired it (macOS: /dev/cu.<name>; Windows: an outgoing COM port). */
export async function pairSerialPrinter(): Promise<SerialSession> {
  const port = await serial().requestPort({});
  // Re-picking the port we are already holding is a no-op, not an error.
  if (held?.port === port && held.opened) return held;
  await ensureOpen(port);
  const session: SerialSession = { port, opened: true };
  held = session;
  return session;
}

/** Reuse an already-granted port, else prompt. Chrome remembers granted ports per
 *  origin, so after the first pairing this is silent. */
export async function heldSerialSession(): Promise<SerialSession> {
  if (held?.opened) return held;
  // TRY THEM ALL, not just the first. A Mac lists several serial ports — a
  // Bluetooth-Incoming-Port and a debug console sit alongside the printer — so
  // whichever comes back first is not necessarily the one that was paired, and
  // giving up on it threw away the rest and re-prompted.
  for (const port of await serial().getPorts()) {
    try {
      await ensureOpen(port);
      held = { port, opened: true };
      return held;
    } catch {
      // In use by another tab, or gone. Try the next.
    }
  }
  return pairSerialPrinter();
}

/** Write bytes to the port, chunked and paced. */
async function writeAll(session: SerialSession, bytes: Uint8Array): Promise<void> {
  const stream = session.port.writable;
  if (!stream) throw new Error("serial port is not writable");
  const writer = stream.getWriter();
  try {
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await writer.write(bytes.subarray(i, i + CHUNK));
      if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
    }
  } finally {
    writer.releaseLock();
  }
}

/** Render + encode + send ONE label over serial.
 *
 *  Byte-for-byte the same job a Bluetooth printer of the same protocol receives:
 *  the only difference is which pipe it goes down. */
export async function printOneOverSerial(
  content: LabelContent,
  settings: BluetoothPrinterSettings,
): Promise<void> {
  if (!isWebSerialAvailable()) throw new Error(NO_WEB_SERIAL);
  const session = await heldSerialSession();
  const f = effectiveFootprint(settings);
  const bmp = await renderLabelBitmap(content, f.widthDots, Math.round(mmToDots(f.labelHeightMm)));
  try {
    await writeAll(session, encodeForPrinter(bmp, settings));
  } catch (e) {
    // A write that fails on a session we believed live usually means the port
    // died between prints. Drop it so the next attempt re-opens cleanly rather
    // than failing forever against a dead handle.
    await releaseHeldSerialPrinter();
    throw e;
  }
}

export interface SerialBatchItem extends LabelContent {
  id?: string;
  copies?: number;
}

export interface SerialBatchResult {
  printed: SerialBatchItem[];
  failed: { item: SerialBatchItem; error: string }[];
}

/** Print a queue over serial, reporting per-row failure instead of aborting the
 *  batch — paper already spent on rows 1..n is not recovered by giving up. */
export async function printBatchOverSerial(
  items: SerialBatchItem[],
  settings: BluetoothPrinterSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<SerialBatchResult> {
  if (!isWebSerialAvailable()) throw new Error(NO_WEB_SERIAL);
  const session = await heldSerialSession();
  const f = effectiveFootprint(settings);
  const heightDots = Math.round(mmToDots(f.labelHeightMm));
  const total = items.reduce((n, i) => n + Math.max(1, i.copies ?? 1), 0);

  const printed: SerialBatchItem[] = [];
  const failed: { item: SerialBatchItem; error: string }[] = [];
  let done = 0;

  for (const item of items) {
    try {
      const bmp = await renderLabelBitmap(item, f.widthDots, heightDots);
      const bytes = encodeForPrinter(bmp, settings);
      for (let c = 0; c < Math.max(1, item.copies ?? 1); c++) {
        await writeAll(session, bytes);
        done += 1;
        onProgress?.(done, total);
        setPrintProgress(done >= total ? null : { done, total });
      }
      printed.push(item);
    } catch (e) {
      failed.push({ item, error: e instanceof Error ? e.message : String(e) });
    }
  }
  setPrintProgress(null);
  return { printed, failed };
}


// ── identify the printer by ASKING it ───────────────────────────────────────
//
// Web Serial hides the port name, so there is no "PM240" string to match on. But
// an HCI capture of the printer's own app gave us its status commands, so the
// printer can simply be asked what it is and what is loaded — which is better
// than a name match anyway, because it reports the CURRENT roll rather than
// whatever was configured once.

/** `ESC ! o` — status. The reply carries the dimensions of the roll the printer
 *  has SENSED. A capture proved that is live rather than an echo of the last
 *  configured size: the reported media changed the moment the roll was swapped,
 *  seven minutes before any SIZE command was sent. Decoding lives in
 *  thermal-print/status so the BLE path and the edge bridge can reuse it.
 *
 *  The CRLF is REQUIRED, and that is hardware-verified, not assumed: on a link
 *  that had just answered a CRLF command, the same commands terminated with a
 *  bare CR were ignored. (The vendor capture appears to send bare CR, but that
 *  is an RFCOMM credit-byte artifact of the decoder, not the real framing.) */
const CMD_STATUS = new TextEncoder().encode("\x1b!o\r\n");
/** `BATTERY?` — replies "BATTERY <level>", where level is a RAW byte. */
const CMD_BATTERY = new TextEncoder().encode("BATTERY?\r\n");

export interface SerialPrinterIdentity {
  /** The roll the printer says is loaded, sensed by the printer itself. */
  widthMm?: number;
  heightMm?: number;
  /** Battery as bars + volts + the raw byte. Bars rather than a percentage: the
   *  printers and their own apps display bars, and the voltage mapping rests on
   *  a single calibration point. */
  battery?: BatteryReading;
  /** True when the printer answered at all — proof it speaks this dialect. */
  responded: boolean;
}

/** How long to keep listening for an identity before giving up. Generous on
 *  purpose: bringing up a Bluetooth Classic link takes seconds, and the cost of
 *  being impatient is telling the user their printer said nothing when it did. */
const IDENTIFY_BUDGET_MS = 6000;

/** Re-ask if nothing has arrived by here. Measured on real hardware: the first
 *  command written after opening the port is frequently swallowed while the
 *  link is still establishing. */
const RETRY_AFTER_MS = 2200;

/** Once the printer has said something and then gone quiet this long, it is
 *  done. Without this, a printer that answers the roll but not the battery — or
 *  the reverse — would hold the connect flow for the whole budget with nothing
 *  left to wait for. */
const QUIET_MS = 700;

/** A command the printer has not answered within this window is not getting an
 *  answer. The quiet-settle above must not fire before the LAST command has had
 *  this long: the first version settled 700 ms after the status reply and cut
 *  off a battery answer that was still on its way. */
const ANSWER_WINDOW_MS = 2000;

/** When the status reply has not shown up this far in, send the battery query
 *  anyway rather than serialising forever behind a reply that may never come. */
const BATTERY_AT_MS = 1500;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Ask the already-connected printer for a fresh reading.
 *
 *  Deliberately NOT cached or persisted: the roll can be swapped and the battery
 *  drains, so a stored reading would go quietly stale and be worse than none. */
export async function readSerialPrinterStatus(): Promise<SerialPrinterIdentity> {
  if (!isWebSerialAvailable()) throw new Error(NO_WEB_SERIAL);
  return identifySerialPrinter(await heldSerialSession());
}

/** Ask the printer what it is and what roll is loaded.
 *
 *  NEVER MATCHES A REPLY TO A COMMAND BY ARRIVAL ORDER. Serial carries no
 *  framing and this link is slow to wake, so a reply routinely lands well after
 *  the command that asked for it. Both answers are self-describing — the media
 *  status is binary behind a declared length, the battery is text-prefixed — so
 *  everything received is accumulated into one buffer and each answer is picked
 *  out by SHAPE, whenever it happens to arrive.
 *
 *  Measured against a real PM240 over /dev/cu.PM240: the earlier version sent
 *  the status query, read for 700 ms, cancelled the reader, then sent the
 *  battery query. Cancelling chopped the stream mid-reply, so the status answer
 *  surfaced inside the NEXT read and was parsed as a battery reply. The printer
 *  had answered correctly every time; the code reported "didn't identify
 *  itself".
 *
 *  Best-effort by design: a printer that truly says nothing is not an error, it
 *  just means the user fills the form in as before. */
export async function identifySerialPrinter(
  session: SerialSession,
  opts: { budgetMs?: number } = {},
): Promise<SerialPrinterIdentity> {
  const out: SerialPrinterIdentity = { responded: false };
  const stream = session.port.readable;
  if (!stream) return out;

  const budget = opts.budgetMs ?? IDENTIFY_BUDGET_MS;
  const started = Date.now();
  const deadline = started + budget;
  const reader = stream.getReader();
  // ONE reader for the whole exchange. Taking a fresh reader per command is what
  // lost bytes before.
  let buf: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  // A read() left pending when the timeout wins must be carried to the next
  // iteration, not abandoned — an abandoned one still resolves, and its chunk
  // would vanish.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let statusAsks = 0;
  let batteryAsked = false;
  let lastByteAt = 0;
  let lastWriteAt = started;

  // The two queries are SEQUENCED, not written back-to-back. Hardware runs where
  // both went out in one burst got a status reply and never a battery reply;
  // asked on its own, the same printer answered the battery query. The battery
  // command follows once the status answer is in (or its window has lapsed).
  const askStatus = async () => {
    statusAsks++;
    lastWriteAt = Date.now();
    await writeAll(session, CMD_STATUS);
  };
  const askBattery = async () => {
    batteryAsked = true;
    lastWriteAt = Date.now();
    await writeAll(session, CMD_BATTERY);
  };

  try {
    await askStatus();
    while (Date.now() < deadline) {
      if (!pending) {
        pending = reader.read();
        // The loop can exit with this read still outstanding; releaseLock then
        // rejects it, and with no handler that surfaces as an unhandled
        // rejection in the console. Mark it handled up front.
        pending.catch(() => {});
      }
      const slice = Math.min(300, Math.max(1, deadline - Date.now()));
      const timedOut = Symbol("timeout");
      const timeout = new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), slice));
      const result = await Promise.race([pending, timeout]);

      if (result !== timedOut) {
        pending = null;
        if (result.done) break;
        if (result.value?.length) {
          buf = concat(buf, result.value);
          out.responded = true;
          lastByteAt = Date.now();
        }
      }

      const media = parseMediaReading(buf);
      const battery = parseBatteryReply(buf);
      if (media) { out.widthMm = media.widthMm; out.heightMm = media.heightMm; }
      if (battery) out.battery = battery;
      if (media && battery) break;             // nothing left to wait for

      if (!batteryAsked && (media || Date.now() - started > BATTERY_AT_MS)) await askBattery();

      // Still silent well into the budget: the opening command was probably
      // swallowed while the link came up. Ask once more.
      if (statusAsks === 1 && !out.responded && Date.now() - started > RETRY_AFTER_MS) await askStatus();

      // It spoke, then stopped, we have something usable, AND the most recent
      // command has had a fair window: stop waiting for an answer that is not
      // coming. The write-window guard matters — settling on quiet alone once
      // cut off a battery reply that arrived just after the status one.
      if (
        (media || battery) && batteryAsked && lastByteAt &&
        Date.now() - lastByteAt > QUIET_MS &&
        Date.now() - lastWriteAt > ANSWER_WINDOW_MS
      ) break;
    }
  } catch {
    /* a read error just means no identity; the caller falls back to manual */
  } finally {
    try { reader.releaseLock(); } catch { /* already gone */ }
  }
  return out;
}
