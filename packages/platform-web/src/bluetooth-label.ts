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
import { setPrintProgress } from "./print-progress.js";
import {
  CANDIDATE_SERVICES,
  composeMediaNUp,
  connectAndDiscover,
  dotsToMm,
  encodePhomemo,
  encodeTsplParts,
  knownPrinters,
  KNOWN_PROFILES,
  matchProfile,
  pickBoundDevice,
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
  type FeedType,
  type LabelFace,
  type LabelMedia,
  type MonoBitmap,
  type PrinterProfile,
  type ThermalFootprint,
  type TsplMedia,
} from "@cobblr/thermal-print";

/** Settings stored on a core-print printer row with driver "browser-bluetooth". */
export interface BluetoothPrinterSettings {
  profileId?: string;
  protocol: "tspl" | "phomemo";
  widthDots: number;
  /** Widest media (mm) the printer can feed — its capability, funnels the offered
   *  sizes. From the matched profile; independent of what's currently loaded. */
  maxWidthMm?: number;
  writeCharUuid?: string;
  labelHeightMm?: number;
  gapMm?: number;
  direction?: 0 | 1;
  topMarginDots?: number;
  density?: number;
  speed?: number;
  /** Stop the printer advancing to the tear bar after each label. Worth setting
   *  when an UNCODED roll costs a blank label per print: the printer cannot
   *  back-feed media whose geometry it was never told. */
  tearOff?: boolean;
  /** The unified media+label model (D3). When both are present they are the SOURCE
   *  and the footprint (widthDots/labelHeightMm/gapMm) is derived from them; when
   *  absent a pre-D3 printer keeps using the raw footprint fields, byte-for-byte
   *  unchanged. See docs/design-decisions/label-media-and-accumulation.md D3. */
  media?: LabelMedia;
  label?: LabelFace;
  /** Web Bluetooth's id for the physical unit this row is bound to. The only way
   *  to tell two same-model printers apart; origin-scoped and randomised, so it is
   *  stable per browser and absent on a new one (re-picked once, then re-bound). */
  deviceId?: string;
  /** Show EVERY BLE device in the chooser instead of just known printers. The
   *  escape hatch for a printer that advertises neither a known service nor a
   *  known name — it would otherwise be unpairable. Not persisted; set per attempt. */
  showAllDevices?: boolean;
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
  /** The short human-readable code (`m1`, `p42`) drawn in the QR centre, matching
   *  the on-screen preview. EC=H keeps the covered modules decodable. */
  centerCode?: string;
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
  /** The physical unit this session actually reached. Callers persist it onto the
   *  printer row so the next reconnect is unambiguous. */
  deviceId: string;
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
): Promise<{ deviceName: string; deviceId: string; reconnected: boolean }> {
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
  return { deviceName: session.deviceName, deviceId: session.deviceId, reconnected: session.reconnected };
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
    // pickBoundDevice owns the rules (see device-binding.ts): a row bound to a
    // device.id only ever reconnects to THAT unit, and two same-model units with
    // nothing bound refuse to guess rather than print on the wrong machine.
    const picked = pickBoundDevice(known, settings, (d, profileId) => !!d.name && matchProfile(d.name)?.id === profileId);
    if (picked.device) {
      device = picked.device;
      reconnected = true;
    }
  } catch {
    /* fall through to the chooser */
  }

  if (!device) {
    // Filtered to known printer services + model name prefixes, so the chooser is
    // printers rather than every BLE object in range. `showAllDevices` is the
    // caller's escape hatch for a printer that advertises neither (see
    // requestPrinter) — without it such a printer could never be paired.
    device = await requestPrinter([...CANDIDATE_SERVICES], {
      all: settings.showAllDevices,
      namePrefixes: KNOWN_PROFILES.flatMap((p) => p.namePrefixes),
    });
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
    deviceId: device.id,
    profileId: (device.name ? matchProfile(device.name)?.id : undefined) ?? settings.profileId,
    reconnected,
  };
}

/** Build the settings for a printer row from a matched profile, so a connect flow
 *  can save a working Bluetooth printer with ZERO hand-entry. Everything comes
 *  from the (hardware-confirmed) profile: width, dialect, orientation, top margin,
 *  and — for die-cut stock — the label height + gap split from pitchMm.
 *  Unit-tested against the bundled profiles. */
export function settingsFromProfile(p: PrinterProfile): BluetoothPrinterSettings {
  const labelHeightMm = p.labelHeightMm ?? (p.pitchMm != null ? Math.round((p.pitchMm - 2) * 10) / 10 : undefined);
  const gapMm =
    p.pitchMm != null && labelHeightMm != null ? Math.max(0, Math.round((p.pitchMm - labelHeightMm) * 100) / 100) : undefined;
  const widthMm = Number(dotsToMm(p.defaultWidthDots).toFixed(1));
  const heightMm = labelHeightMm ?? 30;
  const feed: FeedType = p.defaults.media === "continuous" ? "continuous" : "die-cut";
  // The loaded stock, and one label face per media by default. The setup's "labels
  // across" narrows the face to fit N per media (n-up); mediaTiles then tiles it.
  const media: LabelMedia = { widthMm, heightMm, feed, gapMm: gapMm ?? 0 };
  const label: LabelFace = { widthMm, heightMm };
  return {
    profileId: p.id,
    protocol: p.protocol,
    widthDots: p.defaultWidthDots,
    maxWidthMm: p.maxWidthMm,
    writeCharUuid: p.writeCharUuid,
    labelHeightMm,
    gapMm,
    direction: p.direction ?? 0,
    topMarginDots: p.topMarginDots ?? 0,
    density: p.defaults.density,
    speed: p.defaults.speed,
    media,
    label,
  };
}

/** Pair a Bluetooth printer via the chooser (needs a user gesture in the call
 *  stack) and describe it from its bundled profile, so a caller can persist a
 *  working printer with no hand-entry. `settings` is null for a model we do not
 *  recognise — the caller then sends the user to the manual fields. The detection
 *  session is closed right after; the real print re-opens the now-granted device
 *  with no chooser. */
export async function pairBluetoothPrinter(opts: { showAllDevices?: boolean } = {}): Promise<{
  deviceName: string;
  profile: PrinterProfile | null;
  settings: BluetoothPrinterSettings | null;
}> {
  // Width here is a throwaway — pairing ignores it; the profile carries the real one.
  const session = await connectPrinter({
    protocol: "tspl",
    widthDots: 320,
    showAllDevices: opts.showAllDevices,
  });
  const profile =
    (session.profileId ? KNOWN_PROFILES.find((p) => p.id === session.profileId) : null) ?? matchProfile(session.deviceName) ?? null;
  closePrinter(session);
  // Bind the row to the physical unit chosen in the chooser — the one moment a
  // human disambiguates two identical printers.
  const settings = profile ? { ...settingsFromProfile(profile), deviceId: session.deviceId } : null;
  return { deviceName: session.deviceName, profile, settings };
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

// The cell layout + caption geometry live in @cobblr/platform-contract: the
// server-side PDF renderer needs the SAME numbers and cannot import this package
// (browser deps), so a shared home had to be reachable from both. Re-exported
// here so existing importers are unaffected. labelLayoutFor still mirrors
// pickCellLayout in modules/labels/src/label-sizes.ts, pinned by sizes.test.ts.
export { captionBox, labelLayoutFor, type CaptionBox, type LabelLayout } from "@cobblr/platform-contract/label-geometry";
import { captionBox, labelLayoutFor, MARGIN_FRAC } from "@cobblr/platform-contract/label-geometry";

/** The caption font size that best FILLS a text box: a short name ("Office") prints
 *  large, a long one ("2019 Honda Civic") shrinks and wraps to fit (up to maxLines).
 *  The QR is already at its max, so the NAME is what adapts. Pure + shared by the
 *  BLE renderer AND the preview/⌘P HTML (both import this), so the printed and
 *  on-screen text size identically. A glyph-advance ESTIMATE (not a canvas measure)
 *  keeps both sides computing the same number. Units are the caller's (px, or in ×
 *  96); the return is in those same units. */
export function fitCaptionPx(
  text: string,
  boxW: number,
  boxH: number,
  opts: { maxLines?: number; min?: number; max?: number; measure?: (text: string) => number } = {},
): number {
  const t = (text ?? "").trim();
  // Units are the caller's (px or inches), so min/max default to no clamp — the
  // caller supplies bounds in its own unit. min defaulting to a px value would clamp
  // an inch-caller's whole range to that number.
  const min = opts.min ?? 0;
  const max = opts.max ?? Infinity;
  if (!t || boxW <= 0 || boxH <= 0) return min;
  const words = t.split(/\s+/).filter(Boolean);
  const n = t.length;
  // Avg glyph advance / font-size for bold system sans. Measured across real label
  // names (bold system-ui) it is ~0.45-0.51; 0.55 keeps a small margin so the
  // longest wrapped line still fits without the HTML re-wrapping. 0.72 was WAY too
  // conservative — it undersized every caption by ~30% and left the text short of
  // the label's left/right extents (the author, 2026-07: "2019 Honda Civic is way too
  // small ... scale to the extents").
  const CHAR = 0.55;
  // Real text width at font-size 1, when the caller can measure (canvas 2d). The
  // CHAR estimate averages ~0.5 for mixed case but "Thumper" runs ~0.62 and "M8"
  // 0.755 — an estimate-sized font then overflows the box and clips. Guarded:
  // a mock/broken canvas returning 0 falls back to the estimate.
  const measured = opts.measure ? opts.measure(t) : NaN;
  const w1 = Number.isFinite(measured) && measured > 0 ? measured : n * CHAR;
  const LINE = 1.12;
  // CHAR is an ESTIMATE, so a font it says fits on `lc` lines can still wrap to
  // lc+1 in the browser and then overrun the box (a digit-heavy name — wide
  // glyphs — overflowed a 1.5in square strip by ~5px). Keep a small margin on the
  // WIDTH bound so "fits on lc lines" is true when rendered.
  //
  // Do NOT instead require the font to also fit lc+1 lines: that halves every
  // caption whose word count allows wrapping, while leaving one-word captions
  // untouched (maxLines collapses to 1 for those). It shipped once and made
  // "Prusa MINI+" print at half the size of "Thumper" beside it — the author, 2026-07.
  const WIDTH_SAFETY = 0.94;
  const maxLines = Math.max(1, Math.min(opts.maxLines ?? 2, words.length));
  let best = 0;
  for (let lc = 1; lc <= maxLines; lc++) {
    const byWidth = (boxW * WIDTH_SAFETY) / (w1 / lc);
    const byHeight = boxH / (lc * LINE);
    best = Math.max(best, Math.min(byWidth, byHeight));
  }
  return Math.max(min, Math.min(max, best));
}

/** Greedily wrap `text` to at most `maxLines` lines fitting `maxW` px at the set
 *  font. The last line is ellipsised if the whole caption doesn't fit. `ctx.font`
 *  must already be set. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // Any remaining words overflowed the line budget — ellipsise the last line.
  const usedWords = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (usedWords < words.length && lines.length) {
    let last = lines[lines.length - 1]!;
    while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

/** Draw a block of caption lines centred in the box (x, y, w, h). `align` positions
 *  each line; the block is vertically centred. */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  fontPx: number,
  align: "center" | "left",
  valign: "top" | "middle" = "middle",
): void {
  if (!lines.length) return;
  ctx.fillStyle = "#000";
  ctx.font = `bold ${fontPx}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const lineH = Math.round(fontPx * 1.15);
  const blockH = lines.length * lineH;
  // TOP hugs the top of the box (a caption strip); MIDDLE centres (text beside a QR).
  const startY = y + (valign === "top" ? 0 : Math.max(0, (h - blockH) / 2)) + lineH / 2;
  const tx = align === "center" ? x + w / 2 : x;
  lines.forEach((ln, i) => ctx.fillText(ln, tx, startY + i * lineH, w));
}

/** The human-readable code badge in the QR centre (circle ≤2 chars, pill for 3+),
 *  matching the preview + PDF. White fill so it stays legible over the modules;
 *  EC=H keeps the QR decodable under it. */
function drawCenterCode(ctx: CanvasRenderingContext2D, code: string, cx: number, cy: number, qrSize: number): void {
  const fontPx = Math.max(9, Math.round(qrSize * 0.16));
  ctx.font = `bold ${fontPx}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textW = ctx.measureText(code).width;
  const padX = Math.round(fontPx * 0.5);
  const h = Math.round(fontPx * 1.5);
  const w = code.length <= 2 ? h : Math.max(h, Math.round(textW + padX * 2));
  const r = h / 2;
  const x = cx - w / 2, y = cy - h / 2;
  // rounded-rect (a circle when w === h)
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.fillText(code, cx, cy + 1);
}

/** Render one label to a 1-bpp bitmap at the face's dot size, laid out to MATCH THE
 *  ON-SCREEN PREVIEW (renderPrintSheetHtml): a whitespace margin (never edge-to-edge
 *  — misalignment tolerance + the printer's soft/unreachable edges), a wrapped
 *  caption and QR placed by the cell layout (portrait/square = caption on top, QR
 *  below; row = QR left, caption right), and the centre-code badge. Exported so a
 *  preview can show exactly what will be sent. `heightDots` defaults to a portrait
 *  QR-plus-caption box for callers that haven't passed a face height yet. */
export async function renderLabelBitmap(
  content: LabelContent,
  widthDots: number,
  heightDots?: number,
): Promise<MonoBitmap> {
  const W = Math.max(1, Math.round(widthDots));
  const H = Math.max(1, Math.round(heightDots ?? widthDots * 1.25));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas context");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;

  const caption = content.caption?.trim() ?? "";
  const layout = labelLayoutFor(W, H);
  // Geometry comes from the SHARED captionBox (in dots here, inches in the HTML
  // sheet) so the thermal print and the preview lay out identically.
  const box = captionBox(W, H, layout);
  // Position at the margins the box was computed FROM — the sides are wider than
  // the feed direction to absorb lateral paper wander, so a single symmetric `m`
  // here would put content where the box does not expect it.
  const m = Math.max(4, Math.round(box.marginY));
  const cx = Math.max(4, Math.round(box.marginX)), cy = m;
  const cw = Math.max(1, Math.round(box.contentW));
  const chAll = Math.max(1, Math.round(box.contentH));

  const drawQr = async (qx: number, qy: number, size: number): Promise<void> => {
    const s = Math.max(1, Math.round(size));
    const qr = document.createElement("canvas");
    await QRCode.toCanvas(qr, content.qrPayload, {
      width: s,
      margin: 0,
      errorCorrectionLevel: "H", // survives thermal wear + the centre badge
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
    ctx.drawImage(qr, Math.round(qx), Math.round(qy));
    if (content.centerCode) drawCenterCode(ctx, content.centerCode, qx + s / 2, qy + s / 2, s);
  };

  const qrSize = Math.round(box.qrSize);
  if (layout === "row") {
    // QR left (square, full content height); caption right, auto-fit to its box.
    await drawQr(cx, cy + (chAll - qrSize) / 2, qrSize);
    if (caption) {
      const tw = Math.max(1, Math.round(box.fitW));
      const tx = cx + cw - tw; // right-hand column, gutter already in box.fitW
      const fontPx = fitCaptionPx(caption, tw, box.fitH, { maxLines: box.maxLines, min: box.minFont, max: box.fitH });
      ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
      drawCaption(ctx, wrapLines(ctx, caption, tw, box.maxLines), tx, cy, tw, chAll, fontPx, "left");
    }
  } else {
    // Caption TOP, QR anchored to the FLOOR at the bottom (the author, 2026-07: "the QRs
    // should have a floor they anchor to" — so every label's QR bottom lines up).
    // Every dimension comes from the shared captionBox, so this matches the preview.
    const floor = Math.round(box.floor);
    const strip = Math.round(box.strip);
    if (caption && strip > 4) {
      const measure = (text: string) => {
        ctx.font = "bold 100px system-ui, sans-serif";
        return ctx.measureText(text).width / 100;
      };
      const fontPx = fitCaptionPx(caption, cw, box.fitH, { maxLines: box.maxLines, min: box.minFont, max: box.fitH, measure });
      ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
      // Centred in the strip between the label top and the QR — the approved
      // placement (a top-hugging caption reads as floating away from its QR).
      drawCaption(ctx, wrapLines(ctx, caption, cw, box.maxLines), cx, cy, cw, strip, fontPx, "center", "middle");
    }
    await drawQr(cx + (cw - qrSize) / 2, cy + chAll - qrSize - floor, qrSize);
  }

  const img = ctx.getImageData(0, 0, W, H);
  return packMonoBitmap(new Uint8Array(img.data), W, H, 128);
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
      ? { ...tsplMediaFrom(s.media, s.label, { direction: s.direction ?? 0, density: s.density, speed: s.speed }), tearOff: s.tearOff }
      : {
          widthMm: Number((s.widthDots / 8).toFixed(2)), // 203 dpi = 8 dots/mm
          heightMm: s.labelHeightMm ?? 30,
          gapMm: s.gapMm ?? 2,
          direction: s.direction ?? 0,
          tearOff: s.tearOff,
          density: s.density,
          speed: s.speed,
        };
  // BITMAP rather than TSPL's QRCODE: some firmware omits QRCODE entirely and
  // silently drops the object. Rasterising always works. Polarity inverts inside.
  return encodeTsplParts(media, [tsplBitmap(0, topOffsetDots(s), bmp)]);
}

/** The y offset (dots) to draw a rendered bitmap at.
 *
 *  Two margins used to STACK. A profile's `topMarginDots` exists to clear the
 *  printer's physical dead zone at the top of the label, but renderLabelBitmap
 *  ALREADY leaves its own whitespace margin inside the bitmap — so shifting the
 *  whole bitmap down by the dead zone added the two together. On a PM220S / 50x30
 *  label that put the first ink 4.8 mm down (3.0 dead zone + 1.8 internal) while
 *  the bottom kept only 1.8 mm, and the print visibly sat low (the author, 2026-07).
 *
 *  The bitmap's own white already satisfies part of the dead zone, so only the
 *  DIFFERENCE needs shifting: the total top inset becomes max(internal, deadzone)
 *  rather than their sum. Lowering "Top margin" on the Printers page then moves the
 *  print further up; at 0 the top and bottom margins match and the content is
 *  vertically centred on the label. */
export function topOffsetDots(s: BluetoothPrinterSettings): number {
  const deadZone = s.topMarginDots ?? 0;
  // Derive the internal margin from the LABEL FACE, not from the bitmap handed in:
  // a tiled sheet is many faces tall, and a synthetic bitmap has no margin at all,
  // so measuring the argument would give a number unrelated to the white that
  // renderLabelBitmap actually left at the top of the first label.
  const f = effectiveFootprint(s);
  const faceH = Math.round(mmToDots(f.labelHeightMm));
  // Floor of 4 matches renderLabelBitmap's own positioning floor exactly — a
  // different floor here would re-introduce a tiny stack on very small faces.
  const internal = Math.max(4, Math.round(Math.min(f.widthDots, faceH) * MARGIN_FRAC));
  return Math.max(0, deadZone - internal);
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
    tearOff: s.tearOff,
    density: s.density,
    speed: s.speed,
  };
  return encodeTsplParts(media, [tsplBitmap(0, topOffsetDots(s), sheet)]);
}

// ── printing ────────────────────────────────────────────────────────────────
/** Print one label to an OPEN session. No chooser, no gesture — safe in a loop. */
export async function printToSession(
  session: PrinterSession,
  content: LabelContent,
  settings: BluetoothPrinterSettings,
): Promise<{ bytes: number }> {
  const fp = effectiveFootprint(settings);
  const labelHDots = mmToDots(settings.label?.heightMm ?? settings.labelHeightMm ?? 30);
  const bmp = await renderLabelBitmap(content, fp.widthDots, labelHDots);
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
  /** The physical unit this batch actually printed on. Callers persist it onto
   *  the printer row, which binds an ALREADY-PAIRED printer on its next print —
   *  otherwise only newly-paired rows would ever get a binding. */
  deviceId: string;
  reconnected: boolean;
}

/** Labels per feed for this printer's loaded media: cols×rows when the media holds
 *  more than one label face (n-up), else 1 (the historical one-per-feed). */
export function tileCount(s: BluetoothPrinterSettings): number {
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
  const labelHDots = mmToDots(label.heightMm);
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
      const bitmaps = await Promise.all(chunk.map((c) => renderLabelBitmap(c.content, labelWDots, labelHDots)));
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
  // Reuse the HELD session (open one if none), and keep it open after — so a second
  // batch, or a batch after connecting, does not re-show Chrome's device chooser.
  // The session self-heals (heldPrinterSession reconnects a dropped link) and is
  // dropped on sign-out / printer change via releaseHeldPrinter.
  const session = await heldPrinterSession(settings);
  const total = items.reduce((n, i) => n + Math.max(1, i.copies ?? 1), 0);
  // Mirror every progress tick into the process-wide store so the Live box can show
  // a taskbar-style count of labels still to print; done===total clears it.
  const report = (d: number, t: number, current?: BatchItem) => {
    setPrintProgress(d >= t ? null : { done: d, total: t, deviceName: session.deviceName });
    onProgress?.(d, t, current);
  };
  try {
    setPrintProgress({ done: 0, total, deviceName: session.deviceName });
    const perSheet = tileCount(settings);
    if (perSheet > 1) {
      const { printed, failed } = await runTiled(session, items, settings, perSheet, report);
      return { printed, failed, deviceName: session.deviceName, deviceId: session.deviceId, reconnected: session.reconnected };
    }
    // One-up: a feed per label (per copy), reporting exactly what failed.
    const printed: BatchItem[] = [];
    const failed: { item: BatchItem; error: string }[] = [];
    let done = 0;
    for (const item of items) {
      const copies = Math.max(1, item.copies ?? 1);
      for (let c = 0; c < copies; c++) {
        report(done, total, item);
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
    report(done, total);
    return { printed, failed, deviceName: session.deviceName, deviceId: session.deviceId, reconnected: session.reconnected };
  } finally {
    setPrintProgress(null);
    // Session stays HELD for the next print (no closePrinter) — releaseHeldPrinter
    // drops it on sign-out / printer change.
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
