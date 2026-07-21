// Printing labels to a Bluetooth thermal printer FROM THE BROWSER.
//
// Lives in platform-web because two surfaces need it: the Printers config page
// (test print) and the labels module's print queue (your actual labels). A module
// cannot import from web/src, and web cannot import a module, so the shared web
// package is the only honest home for it.
//
// THE SESSION IS THE POINT. navigator.bluetooth.requestDevice() requires a user
// gesture and shows the device chooser, so a naive "print each row" loop would
// prompt once per label — unusable for a queue. connectPrinter() reuses an
// already-granted device via knownPrinters() when the browser allows it, and the
// returned session is then written to repeatedly with no further prompts. One
// gesture per session, not per label.
//
// iOS has no Web Bluetooth and never will; callers must say so plainly rather
// than appear broken. Use isWebBluetoothAvailable().

import QRCode from "qrcode";
import {
  CANDIDATE_SERVICES,
  composeMediaNUp,
  connectAndDiscover,
  dotsToMm,
  encodePhomemo,
  encodeTsplParts,
  knownPrinters,
  matchProfile,
  mediaTiles,
  mmToDots,
  packMonoBitmap,
  requestPrinter,
  streamToChar,
  thermalFootprint,
  tsplBitmap,
  tsplMediaFrom,
  type BleCharacteristic,
  type BleDevice,
  type LabelFace,
  type LabelMedia,
  type MonoBitmap,
  type ThermalFootprint,
  type TsplMedia,
} from "@cobblr/thermal-print";

/** Settings stored on a core-print printer row with driver "browser-bluetooth". */
export interface BluetoothPrinterSettings {
  profileId?: string;
  protocol: "tspl" | "phomemo";
  widthDots: number;
  writeCharUuid?: string;
  labelHeightMm?: number;
  gapMm?: number;
  direction?: 0 | 1;
  topMarginDots?: number;
  density?: number;
  speed?: number;
  /** The unified media+label model (D3). When both are present they are the SOURCE
   *  and the footprint (widthDots/labelHeightMm/gapMm) is derived from them; when
   *  absent a pre-D3 printer keeps using the raw footprint fields, byte-for-byte
   *  unchanged. See docs/design-decisions/label-media-and-accumulation.md D3. */
  media?: LabelMedia;
  label?: LabelFace;
}

/** The single-label footprint this printer actually prints at: derived from
 *  media+label when the D3 model is set, else the stored raw fields. Keeping this
 *  in ONE place means every render/connect site agrees on the width. */
export function effectiveFootprint(s: BluetoothPrinterSettings): ThermalFootprint {
  if (s.media && s.label) return thermalFootprint(s.media, s.label);
  return { widthDots: s.widthDots, labelHeightMm: s.labelHeightMm ?? 30, gapMm: s.gapMm ?? 2 };
}

/** One label's content. `qrPayload` must be the server-minted scan URL — never a
 *  guessed origin, or the printed code resolves to nothing. */
export interface LabelContent {
  qrPayload: string;
  caption?: string;
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

export const NO_WEB_BLUETOOTH =
  "This browser has no Web Bluetooth. Use Chrome or Edge on a desktop or Android device. " +
  "iOS (Safari and Chrome alike) cannot drive Bluetooth printers from a web page.";

// ── the held session ────────────────────────────────────────────────────────
export interface PrinterSession {
  device: BleDevice;
  writeChar: BleCharacteristic;
  deviceName: string;
  profileId?: string;
  /** True when we reconnected silently (no chooser shown). */
  reconnected: boolean;
}

// The session outlives any one print. A batch opens and closes its own, but
// walk-up printing (one label at a time, standing at a shelf) must not pay a
// connect per label — and MUST NOT pay a chooser per label, since the chooser
// needs a user gesture and would make unattended prints impossible.
//
// Module-level rather than React state on purpose: it has to survive route
// changes and component remounts, because a person walking around adding
// things is navigating constantly.
let held: { session: PrinterSession; widthDots: number } | null = null;

/** True when a printer is connected right now, for UI that wants to say so. */
export function heldPrinterName(): string | null {
  return held && held.session.device.gatt?.connected ? held.session.deviceName : null;
}

/** Drop the held session (sign-out, printer changed, user asked to disconnect). */
export function releaseHeldPrinter(): void {
  if (held) {
    closePrinter(held.session);
    held = null;
  }
}

/** A session that persists across prints. Reuses a live connection, silently
 *  re-opens a dropped one (cheap thermal printers drop the link when idle), and
 *  only falls back to the chooser when there is nothing to reuse.
 *
 *  The effective width is part of the key: change the media width and the held
 *  session is stale, because the encoder bakes width into the bytes. */
export async function heldPrinterSession(settings: BluetoothPrinterSettings): Promise<PrinterSession> {
  const widthDots = effectiveFootprint(settings).widthDots;
  if (held && held.widthDots === widthDots) {
    const s = held.session;
    if (s.device.gatt?.connected) return s;
    // Same device, dropped link: reconnect without a chooser. If the device is
    // out of range this throws, and we fall through to a fresh connect.
    try {
      await s.device.gatt!.connect();
      if (s.device.gatt?.connected) return s;
    } catch {
      /* fall through */
    }
  }
  if (held) closePrinter(held.session);
  const session = await connectPrinter(settings);
  held = { session, widthDots };
  return session;
}

/** Print ONE label on the held session. This is the walk-up path: add a thing,
 *  get a label, keep walking. Returns the session's device name for the toast. */
export async function printOneOverBluetooth(
  content: LabelContent,
  settings: BluetoothPrinterSettings,
): Promise<{ deviceName: string; reconnected: boolean }> {
  if (!isWebBluetoothAvailable()) throw new Error(NO_WEB_BLUETOOTH);
  const session = await heldPrinterSession(settings);
  try {
    await printToSession(session, content, settings);
  } catch (e) {
    // A write that fails on a session we thought was live usually means the
    // link died between prints. Drop it so the next attempt reconnects cleanly
    // rather than failing forever against a dead handle.
    releaseHeldPrinter();
    throw e;
  }
  return { deviceName: session.deviceName, reconnected: session.reconnected };
}

/** Open a session. Tries a silent reconnect to an already-granted printer first;
 *  falls back to the chooser, which REQUIRES a user gesture in the call stack. */
export async function connectPrinter(settings: BluetoothPrinterSettings): Promise<PrinterSession> {
  if (!isWebBluetoothAvailable()) throw new Error(NO_WEB_BLUETOOTH);

  let device: BleDevice | null = null;
  let reconnected = false;

  // getDevices() is behind a flag on some builds and simply returns [] there, so
  // this is a best-effort fast path, never a requirement.
  try {
    const known = await knownPrinters();
    if (known.length === 1) {
      device = known[0]!;
      reconnected = true;
    } else if (known.length > 1 && settings.profileId) {
      const match = known.find((d) => d.name && matchProfile(d.name)?.id === settings.profileId);
      if (match) {
        device = match;
        reconnected = true;
      }
    }
  } catch {
    /* fall through to the chooser */
  }

  if (!device) {
    device = await requestPrinter([...CANDIDATE_SERVICES]);
    reconnected = false;
  }

  const conn = await connectAndDiscover(device);
  let writeChar = conn.writeChar;
  if (settings.writeCharUuid) {
    const pinned = settings.writeCharUuid.toLowerCase();
    // connectAndDiscover already ranked the pipes; only override when the row
    // pins one AND that pipe is actually present on this device.
    const present = conn.tree.some((s) => s.chars.some((c) => c.uuid.toLowerCase() === pinned));
    if (present && conn.writeChar.uuid.toLowerCase() !== pinned) {
      const found = await findChar(device, pinned);
      if (found) writeChar = found;
    }
  }

  return {
    device,
    writeChar,
    deviceName: device.name ?? "(unnamed)",
    profileId: (device.name ? matchProfile(device.name)?.id : undefined) ?? settings.profileId,
    reconnected,
  };
}

async function findChar(device: BleDevice, charUuid: string): Promise<BleCharacteristic | null> {
  try {
    const server = await device.gatt!.connect();
    for (const svc of await server.getPrimaryServices()) {
      for (const ch of await svc.getCharacteristics()) {
        if (ch.uuid.toLowerCase() === charUuid) return ch;
      }
    }
  } catch {
    /* keep the ranked pick */
  }
  return null;
}

export function closePrinter(session: PrinterSession): void {
  try {
    session.device.gatt?.disconnect();
  } catch {
    /* already gone */
  }
}

// ── render + encode ─────────────────────────────────────────────────────────
/** Render one label (QR, plus an optional caption) to a 1-bpp bitmap at the
 *  printer's width. Exported so a preview can show exactly what will be sent. */
export async function renderLabelBitmap(content: LabelContent, widthDots: number): Promise<MonoBitmap> {
  const captionH = content.caption ? 28 : 0;
  const qrSize = widthDots - 16;             // small inset: thermal edges are soft
  const canvas = document.createElement("canvas");
  canvas.width = widthDots;
  canvas.height = qrSize + captionH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, content.qrPayload, {
    width: qrSize,
    margin: 1,
    errorCorrectionLevel: "H",               // survives thermal wear + handling
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
  ctx.drawImage(qr, Math.round((widthDots - qrSize) / 2), 0);

  if (content.caption) {
    ctx.fillStyle = "#000";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(content.caption, widthDots / 2, qrSize + 21, widthDots - 8);
  }

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return packMonoBitmap(new Uint8Array(img.data), canvas.width, canvas.height, 128);
}

/** Encode a bitmap in whichever dialect this printer speaks. */
export function encodeForPrinter(bmp: MonoBitmap, s: BluetoothPrinterSettings): Uint8Array {
  if (s.protocol === "phomemo") {
    return encodePhomemo(bmp, { density: s.density ?? 8, speed: s.speed ?? 3, media: "gaps", init: true });
  }
  // media set (D3) → the mm-native projection carries the real media width; else a
  // pre-D3 printer keeps the historical widthDots/8 approximation, byte-for-byte.
  const media: TsplMedia =
    s.media && s.label
      ? tsplMediaFrom(s.media, s.label, { direction: s.direction ?? 0, density: s.density, speed: s.speed })
      : {
          widthMm: Number((s.widthDots / 8).toFixed(2)), // 203 dpi = 8 dots/mm
          heightMm: s.labelHeightMm ?? 30,
          gapMm: s.gapMm ?? 2,
          direction: s.direction ?? 0,
          density: s.density,
          speed: s.speed,
        };
  // BITMAP rather than TSPL's QRCODE: some firmware omits QRCODE entirely and
  // silently drops the object. Rasterising always works. Polarity inverts inside.
  return encodeTsplParts(media, [tsplBitmap(0, s.topMarginDots ?? 0, bmp)]);
}

/** Encode a COMPOSED media sheet (several labels tiled onto the loaded media, D8).
 *  Same dialects as encodeForPrinter, but the TSPL SIZE is the whole tiled panel
 *  (media width × the composed sheet height), not one label, so one feed advances
 *  the full sheet. */
function encodeTiledSheet(sheet: MonoBitmap, s: BluetoothPrinterSettings): Uint8Array {
  if (s.protocol === "phomemo") {
    return encodePhomemo(sheet, { density: s.density ?? 8, speed: s.speed ?? 3, media: "gaps", init: true });
  }
  const media: TsplMedia = {
    widthMm: s.media?.widthMm ?? Number((s.widthDots / 8).toFixed(2)),
    heightMm: Number(dotsToMm(sheet.height).toFixed(2)),
    gapMm: s.media?.feed === "die-cut" ? (s.media.gapMm ?? 0) : 0,
    direction: s.direction ?? 0,
    density: s.density,
    speed: s.speed,
  };
  return encodeTsplParts(media, [tsplBitmap(0, s.topMarginDots ?? 0, sheet)]);
}

// ── printing ────────────────────────────────────────────────────────────────
/** Print one label to an OPEN session. No chooser, no gesture — safe in a loop. */
export async function printToSession(
  session: PrinterSession,
  content: LabelContent,
  settings: BluetoothPrinterSettings,
): Promise<{ bytes: number }> {
  const bmp = await renderLabelBitmap(content, effectiveFootprint(settings).widthDots);
  const bytes = encodeForPrinter(bmp, settings);
  // A single GATT write caps at 512 bytes and label jobs exceed it.
  await streamToChar(session.writeChar, bytes, { chunkSize: 180 });
  return { bytes: bytes.length };
}

export interface BatchItem extends LabelContent {
  /** Echoed back in the result so a caller can mark the right queue row. */
  id?: string;
  copies?: number;
}

export interface BatchResult {
  printed: BatchItem[];
  failed: { item: BatchItem; error: string }[];
  deviceName: string;
  reconnected: boolean;
}

/** Labels per feed for this printer's loaded media: cols×rows when the media holds
 *  more than one label face (n-up), else 1 (the historical one-per-feed). */
function tileCount(s: BluetoothPrinterSettings): number {
  if (!s.media || !s.label) return 1;
  const { cols, rows } = mediaTiles(s.media, s.label);
  return Math.max(1, Math.max(1, cols) * Math.max(1, rows));
}

/** n-up sender (D8): render each label at its FACE width, tile `perSheet` onto one
 *  media bitmap (copies fill tiles first, D4), and feed one composed sheet per pass.
 *  A partial last sheet leaves its remaining tiles blank. */
async function runTiled(
  session: PrinterSession,
  items: BatchItem[],
  settings: BluetoothPrinterSettings,
  perSheet: number,
  onProgress?: (done: number, total: number, current?: BatchItem) => void,
): Promise<{ printed: BatchItem[]; failed: { item: BatchItem; error: string }[] }> {
  const media = settings.media!;
  const label = settings.label!;
  const labelWDots = mmToDots(label.widthMm);
  // Expand copies into a flat run, remembering each label's source item.
  const flat: { item: BatchItem; content: LabelContent }[] = [];
  for (const item of items) {
    for (let c = 0; c < Math.max(1, item.copies ?? 1); c++) flat.push({ item, content: item });
  }
  const total = flat.length;
  const okItems = new Set<BatchItem>();
  const badItems = new Map<BatchItem, string>();
  let done = 0;
  for (let i = 0; i < flat.length; i += perSheet) {
    const chunk = flat.slice(i, i + perSheet);
    onProgress?.(done, total, chunk[0]?.item);
    try {
      const bitmaps = await Promise.all(chunk.map((c) => renderLabelBitmap(c.content, labelWDots)));
      const sheet = composeMediaNUp(bitmaps, media, label);
      await streamToChar(session.writeChar, encodeTiledSheet(sheet, settings), { chunkSize: 180 });
      done += chunk.length;
      chunk.forEach((c) => okItems.add(c.item));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chunk.forEach((c) => badItems.set(c.item, msg)); // whole sheet failed
    }
  }
  onProgress?.(done, total);
  return {
    printed: [...okItems].filter((it) => !badItems.has(it)),
    failed: [...badItems].map(([item, error]) => ({ item, error })),
  };
}

/** Print many labels over ONE session (one gesture). Continues past a failed
 *  label rather than aborting the batch: with paper already spent, stopping
 *  silently mid-run is worse than finishing and reporting exactly what failed.
 *  When the loaded media is multi-up (D8), labels tile onto one sheet per feed. */
export async function printBatchOverBluetooth(
  items: BatchItem[],
  settings: BluetoothPrinterSettings,
  onProgress?: (done: number, total: number, current?: BatchItem) => void,
): Promise<BatchResult> {
  const session = await connectPrinter(settings);
  try {
    const perSheet = tileCount(settings);
    if (perSheet > 1) {
      const { printed, failed } = await runTiled(session, items, settings, perSheet, onProgress);
      return { printed, failed, deviceName: session.deviceName, reconnected: session.reconnected };
    }
    // One-up: a feed per label (per copy), reporting exactly what failed.
    const total = items.reduce((n, i) => n + Math.max(1, i.copies ?? 1), 0);
    const printed: BatchItem[] = [];
    const failed: { item: BatchItem; error: string }[] = [];
    let done = 0;
    for (const item of items) {
      const copies = Math.max(1, item.copies ?? 1);
      for (let c = 0; c < copies; c++) {
        onProgress?.(done, total, item);
        try {
          await printToSession(session, item, settings);
          done++;
        } catch (e) {
          failed.push({ item, error: e instanceof Error ? e.message : String(e) });
          break;                              // don't retry the same row's copies
        }
      }
      if (!failed.some((f) => f.item === item)) printed.push(item);
    }
    onProgress?.(done, total);
    return { printed, failed, deviceName: session.deviceName, reconnected: session.reconnected };
  } finally {
    closePrinter(session);
  }
}

/** One-shot convenience: connect, print a single label, disconnect. */
export async function printLabelOverBluetooth(
  content: LabelContent,
  settings: BluetoothPrinterSettings,
): Promise<{ deviceName: string; bytes: number; profileId?: string }> {
  const session = await connectPrinter(settings);
  try {
    const { bytes } = await printToSession(session, content, settings);
    return { deviceName: session.deviceName, bytes, profileId: session.profileId };
  } finally {
    closePrinter(session);
  }
}
