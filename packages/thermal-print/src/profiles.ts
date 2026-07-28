// Printer profiles — how to talk to a given Bluetooth thermal printer model.
//
// A profile is the durable output of a successful self-test: once we know a
// model's advertised-name shape, GATT write characteristic, media width and good
// density, that config makes the printer work for EVERYONE without a code change.
// Ships with the models we've confirmed against real hardware; the self-test
// collector harvests new ones (verified:false until a human/print confirms them).

import type { PhomemoMedia, PhomemoOptions } from "./protocol.js";

/** Command family. "phomemo" = the ESC/POS raster in protocol.ts; "tspl" = the
 *  label-printer command set in tspl.ts. Discovered the hard way: a POLONO PM220S
 *  is silent to ESC/POS on every characteristic (even a DLE EOT status query) yet
 *  prints happily from TSPL over the same ff02 pipe. */
export type ThermalProtocol = "phomemo" | "tspl";

/** What each transport does on a given model.
 *
 *  `decoy` is its own value on purpose: some printers advertise a BLE GATT tree
 *  that accepts every write and does nothing. That is worse than having none,
 *  because everything looks like it worked. It must never be treated as "works". */
export interface PrinterConnectivity {
  /** BLE from a browser (Web Bluetooth). */
  ble: "works" | "decoy" | "none";
  /** Bluetooth Classic — an edge bridge, or Web Serial where the OS allows it. */
  classic: "works" | "none" | "unknown";
  /** One sentence naming the route that DOES work, shown when one does not. */
  advice?: string;
}

export interface PrinterProfile {
  /** Stable slug, e.g. "phomemo-m220". */
  id: string;
  /** How this model can ACTUALLY be reached, from hardware measurement.
   *
   *  Exists so the UI can say "this model needs a bridge" instead of handing
   *  back whatever error the browser threw. A printer that cannot be driven the
   *  way someone is trying is not a broken printer, and saying so is the
   *  difference between a dead end and a next step. */
  connectivity?: PrinterConnectivity;
  /** Human label for support/UI. */
  label: string;
  /** Advertised BLE-name prefixes that identify this model. Phomemo advertises by
   *  serial (e.g. "Q155E…") as well as by model ("M220"), so list every observed
   *  shape. Matching is case-insensitive prefix. */
  namePrefixes: string[];
  /** GATT service holding the write characteristic. */
  serviceUuid: string;
  /** The characteristic bytes are written to (write / writeWithoutResponse). */
  writeCharUuid: string;
  /** Command family the bytes are encoded in. */
  protocol: ThermalProtocol;
  /** Default dots-per-line for this model's COMMON media (media-dependent; the
   *  self-test / user can override for a specific roll). */
  defaultWidthDots: number;
  /** The widest media (mm) this model can physically feed — its CAPABILITY, not
   *  what's loaded. Funnels which label sizes are offered (only ones that fit).
   *  PM220S = 54mm (~2"), M220 = 80mm (~3"). Bench/spec-verified. Optional: an
   *  auto-harvested profile may not know it yet (the funnel falls back to width). */
  maxWidthMm?: number;
  /** Default encode options (speed / density / media / init). */
  defaults: Required<PhomemoOptions>;
  /** true once confirmed against real hardware; false when auto-harvested. */
  verified: boolean;
  /** TSPL only: 0 or 1; they differ by 180°. A PM220S prints upside down on 1. */
  direction?: 0 | 1;
  /** Calibrated media pitch (label height + gap) in mm — the number that stops the
   *  image walking off the label. Derived by the printed-ruler routine. */
  pitchMm?: number;
  /** The printable label height in mm (die-cut stock). With pitchMm this splits the
   *  pitch into label + gap, so a connect flow persists exact geometry instead of
   *  guessing the split. Absent for continuous media. */
  labelHeightMm?: number;
  /** Calibrated dead zone at the top of every label, in dots. */
  topMarginDots?: number;
  /** Things a support agent needs that aren't expressible as fields. */
  quirks?: string[];
  notes?: string;
}

/** BLE services a self-test page must request up-front (Web Bluetooth only exposes
 *  services named in `optionalServices` — an undeclared service is INVISIBLE after
 *  connect, which reads as "no writable characteristic" on a printer that has one).
 *  Superset of the serial-ish services seen across cheap thermal printers; the
 *  classic Phomemo `0xff00` is first. */
export const CANDIDATE_SERVICES: readonly (number | string)[] = [
  0xff00, // Phomemo / Goojprt family (write 0xff02)
  0xff10,
  0xffe0, // HM-10-style UART (write 0xffe1)
  0xffe5, // (write 0xffe9)
  0xffd0, // some POS/label variants (write 0xffd1)
  0xae30, // "cat printer" GB0x family (write 0xae01)
  0x18f0, // ISSC-style printer service (write 0x2af1)
  0xfee7,
  0xff12,
  "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip/ISSC transparent UART
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART (write 6e400002)
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2", // JieLi SPP-over-BLE (many cheap printers)
  "00001101-0000-1000-8000-00805f9b34fb", // SPP UUID mirrored over GATT by some bridges
  "0000ff00-0000-1000-8000-00805f9b34fb",
];

/** Known (service → write characteristic) pipes, best-documented first. Used to RANK
 *  writable characteristics when connecting to an unknown printer — picking the
 *  first writable char in enumeration order once risked streaming a perfect label
 *  into an OTA/config characteristic. Not required for function (an unknown pipe
 *  still falls back to "any writable"), only for choosing well. */
export const KNOWN_WRITE_PIPES: readonly { service: string; char: string }[] = [
  { service: "0000ff00-0000-1000-8000-00805f9b34fb", char: "0000ff02-0000-1000-8000-00805f9b34fb" }, // Phomemo (hardware-confirmed)
  // Microchip/ISSC transparent UART: 8841 = TX (host→device), 1e4d = RX (notify).
  // Very common on cheap thermal printers; a PM220S exposes it alongside three
  // other bridges, so it must be rankable, not just in CANDIDATE_SERVICES.
  { service: "49535343-fe7d-4ae5-8fa9-9fafd205e455", char: "49535343-8841-43f4-a8d4-ecbe34729bb3" },
  { service: "0000ae30-0000-1000-8000-00805f9b34fb", char: "0000ae01-0000-1000-8000-00805f9b34fb" }, // cat printers
  { service: "e7810a71-73ae-499d-8c15-faa9aef0c3f2", char: "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f" }, // JieLi
  { service: "000018f0-0000-1000-8000-00805f9b34fb", char: "00002af1-0000-1000-8000-00805f9b34fb" }, // ISSC printer
  { service: "0000ffe0-0000-1000-8000-00805f9b34fb", char: "0000ffe1-0000-1000-8000-00805f9b34fb" }, // HM-10 UART
  { service: "0000ffe5-0000-1000-8000-00805f9b34fb", char: "0000ffe9-0000-1000-8000-00805f9b34fb" },
  { service: "0000ffd0-0000-1000-8000-00805f9b34fb", char: "0000ffd1-0000-1000-8000-00805f9b34fb" },
  { service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e", char: "6e400002-b5a3-f393-e0a9-e50e24dcca9e" }, // Nordic UART
];

/** Score a writable characteristic as the print pipe. Higher wins:
 *  known (service,char) pipe ≫ writable char inside a known service ≫ any
 *  writable; write-without-response breaks ties (printers stream that way).
 *
 *  Among KNOWN_WRITE_PIPES the LIST ORDER is the preference (`100 - index`).
 *  "Is a known pipe" does not narrow it down on real hardware: a POLONO PM220S
 *  exposed the ISSC, JieLi, Phomemo AND 18f0 pipes simultaneously (these chips
 *  bridge one UART behind several services). Scoring every known pipe equally let
 *  GATT enumeration order pick the winner — arbitrary. Phomemo ff00/ff02 leads
 *  because it is the pipe this encoder is hardware-confirmed against. */
export function rankWritePipe(serviceUuid: string, charUuid: string, writeNoResponse: boolean): number {
  const svc = serviceUuid.toLowerCase();
  const chr = charUuid.toLowerCase();
  let score = 1;                                            // any writable char
  for (let i = 0; i < KNOWN_WRITE_PIPES.length; i++) {
    const p = KNOWN_WRITE_PIPES[i]!;
    if (p.service === svc && p.char === chr) { score = 100 - i; break; }
    if (p.service === svc) score = Math.max(score, 10);     // right neighborhood
  }
  return score * 2 + (writeNoResponse ? 1 : 0);
}

const PHOMEMO_DEFAULTS: Required<PhomemoOptions> = {
  speed: 3,
  density: 8,
  media: "continuous" as PhomemoMedia,
  init: true,
};

// PM220S: bench-confirmed 2026-07-20 (below). It cost ONE new encoder family (TSPL)
// rather than zero code — the profile-as-data claim holds for everything else about
// it (pipe, width, orientation, calibrated geometry, quirks).
// TYPONOS PM240 — the BLE findings below stand; the CONCLUSION drawn from them
// did not, and it is corrected at the end of this block. It IS now in
// KNOWN_PROFILES, carrying connectivity that says BLE is a decoy, so matching it
// routes people to the transport that works instead of offering one that cannot.
//
// It pairs, accepts every write (zero GATT rejections) and then does nothing, ever.
// What was ruled out ON HARDWARE, so nobody repeats it:
//   · dialect — ESC-POS (3 forms), TSPL (2), CPCL, EPL, ZPL, Niimbot (2): 60 combos
//     over every writable char × 20-byte and 180-byte chunks. All silent.
//   · pipe — all three writable chars (ff02, ff04 writeNR; ff10 write+read).
//   · Bluetooth Classic / SPP — "ruled out BY THE OS" on the strength of macOS
//     system_profiler reporting "Services: 0x400000 < BLE >". THAT WAS WRONG,
//     see the correction below. One field of one tool was read as proof.
//   · missed replies — both notify chars (ff01, ff03) carry a real CCCD (0x2902),
//     so the subscriptions worked. The printer never notified once in ~110 writes.
//   · identity — NO Device Information service (0x180A); the firmware is anonymous,
//     so there is no vendor/model string to look a protocol up by.
//   · replies via register — writing each dialect then re-reading every readable
//     characteristic showed no byte ever change. The firmware parsed none of it.
// GATT is one vendor service 0xff00; ff10 reads back "0d 0a 00 00".
//
// CORRECTED 2026-07-28, on hardware. The PM240 speaks plain TSPL over Bluetooth
// CLASSIC RFCOMM. Its SDP record advertises a serial port on channel 1, and an
// IOBluetoothRFCOMMChannel opened by that channel id read the roll and battery
// 10 times out of 10. So the BLE tree really is a decoy — writes accepted, never
// acted on — and "BLE-only" was a conclusion from a single system_profiler field
// rather than from trying the other radio.
//
// The framing was never proprietary; it is TSPL, and it was reachable the whole
// time down a path that had been declared impossible. The lesson worth keeping:
// "ruled out by the OS" was one tool's summary, not a measurement.
//
// It is driven today by the edge bridge's macrfcomm transport. No browser can
// reach it: Web Bluetooth is BLE-only and the BLE tree is fake, and Web Serial
// cannot open a Classic port on macOS at all (crbug 539890521).
// See docs/design-decisions/bluetooth-classic-printer-hosting.md.

/** Bundled, hardware-confirmed profiles. */
export const KNOWN_PROFILES: readonly PrinterProfile[] = [
  {
    id: "polono-pm220s",
    label: "PM220S", // model only; the id keeps the vendor for uniqueness
    namePrefixes: ["PM220S", "POLONO"],
    serviceUuid: "0000ff00-0000-1000-8000-00805f9b34fb",
    writeCharUuid: "0000ff02-0000-1000-8000-00805f9b34fb",
    protocol: "tspl",
    connectivity: {
      ble: "works",      // prints fine over BLE; it just never ANSWERS there
      classic: "works",  // where its status lives (HCI capture 2026-07-26)
      advice:
        "Prints over Bluetooth from this browser. It only reports its roll and battery " +
        "over Bluetooth Classic, so connect it through an edge bridge if you want those.",
    },
    defaultWidthDots: 320,                    // 40 mm roll @ 203 dpi
    maxWidthMm: 54,                           // 0.91–2.12" media range; a 2"-class printer
    defaults: { speed: 3, density: 8, media: "gaps", init: true },
    verified: true,                           // bench-confirmed 2026-07-20
    direction: 0,
    pitchMm: 32.67,                           // 30 mm label + 2.67 mm gap (refinePitch)
    labelHeightMm: 30,                        // the label itself; gap = pitch - label
    topMarginDots: 24,                        // 3 mm dead zone
    quirks: [
      "Silent to ESC/POS on every characteristic — TSPL only.",
      "TSPL GAPDETECT is a no-op; use the printed-ruler calibration instead.",
      "Never answers notifications over BLE (ff01/ff03/2af0/1e4d) — but it is NOT",
      "  mute: over Bluetooth CLASSIC it answers BATTERY? and ESC ! o with its",
      "  battery and the roll it has sensed (HCI capture 2026-07-26). Reachable",
      "  from a browser via Web Serial only. Read 'no status' as BLE-specific.",
      "Buffers commands while not ready; a lid open/close releases them.",
      "Exposes 5 writable pipes (ISSC/JieLi/Phomemo/18f0) — only ff02 verified.",
      "TSPL QRCODE is NOT implemented — rasterize the QR and send TSPL BITMAP",
      "  (bit polarity inverts: we pack 1=black, BITMAP prints 0). Confirmed",
      "  scannable on real hardware 2026-07-20.",
    ],
  },

  {
    id: "phomemo-m220",
    label: "M220", // model only (the id keeps the vendor for uniqueness)
    // Advertises as its serial (observed "Q155E…") and, on some firmware, "M220".
    namePrefixes: ["M220", "Q155"],
    serviceUuid: "0000ff00-0000-1000-8000-00805f9b34fb",
    writeCharUuid: "0000ff02-0000-1000-8000-00805f9b34fb",
    protocol: "phomemo",
    connectivity: { ble: "works", classic: "unknown" },
    defaultWidthDots: 320, // 40 mm at 203 dpi; M220 does 20–80 mm
    maxWidthMm: 80, // 20–80 mm media range; a 3"-class printer
    defaults: PHOMEMO_DEFAULTS,
    verified: true,
    notes: "GATT service 0xff00 / write char 0xff02 confirmed on real hardware 2026-07.",
  },

  {
    // Present so it can be RECOGNISED, not so it can be paired over BLE. Its
    // connectivity says the BLE tree is a decoy, and every BLE path checks that
    // before offering to pair — which is what the old "keep it out of the list"
    // rule was protecting against, now enforced by data instead of absence.
    id: "typonos-pm240",
    label: "PM240",
    namePrefixes: ["PM240", "TYPONOS"],
    serviceUuid: "0000ff00-0000-1000-8000-00805f9b34fb", // the decoy; never write here
    writeCharUuid: "0000ff02-0000-1000-8000-00805f9b34fb",
    protocol: "tspl",
    connectivity: {
      ble: "decoy", // accepts every write and does nothing, ever (~110 writes)
      classic: "works", // TSPL over RFCOMM, SPP channel 1, 10/10 on hardware
      advice:
        "This model cannot be driven from a browser: its Bluetooth advertisement accepts " +
        "commands and ignores them, and no browser can open its serial port. Connect it " +
        "through an edge bridge, which reads its roll and battery too.",
    },
    defaultWidthDots: 320, // 40 x 30 mm roll @ 203 dpi, as it reports itself
    maxWidthMm: 54,
    defaults: { speed: 3, density: 8, media: "gaps", init: true },
    verified: true, // over CLASSIC (2026-07-28); never over BLE
    direction: 0,
    labelHeightMm: 30,
    notes: "Driven by the edge bridge's macrfcomm transport. See the block above for why BLE is not a path.",
  },
];

/** Case-insensitive prefix match of an advertised BLE name to a known profile.
 *  Returns null when unrecognised — the self-test then discovers the write
 *  characteristic live and offers to harvest a new profile. */
export function matchProfile(
  deviceName: string | null | undefined,
  profiles: readonly PrinterProfile[] = KNOWN_PROFILES,
): PrinterProfile | null {
  if (!deviceName) return null;
  const name = deviceName.toUpperCase();
  for (const p of profiles) {
    if (p.namePrefixes.some((pre) => name.startsWith(pre.toUpperCase()))) return p;
  }
  return null;
}
