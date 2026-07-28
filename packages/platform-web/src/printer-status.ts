// Last known roll + battery per printer, remembered for the tab's lifetime.
//
// WHY A CACHE AND NOT A LIVE READ: asking the printer costs a real exchange, and
// on the hardware this was built against a Bluetooth Classic printer accepts ONE
// serial session per pairing — so a status read per render, or per row, would
// burn the connection the user is about to print with. The reading is therefore
// written only when we were already talking to the printer (on connect, on an
// explicit Check, after a print) and displayed from memory in between.
//
// WHY NOT PERSISTED: the roll gets swapped and the battery drains. A reading
// stored in the database would come back confidently wrong on the next visit,
// which is worse than showing nothing. In-memory means it dies with the tab,
// which is exactly the lifetime over which it stays true.

import { useEffect, useState } from "react";
import type { BatteryReading } from "@cobblr/thermal-print";

export interface PrinterStatusReading {
  widthMm?: number;
  heightMm?: number;
  battery?: BatteryReading;
  /** The printer answered — distinguishes "no coded roll" from "said nothing". */
  responded: boolean;
  /** Epoch ms, so the UI can admit how old the reading is. */
  at: number;
}

const readings = new Map<string, PrinterStatusReading>();
const subscribers = new Set<() => void>();

export function getPrinterStatus(printerId: string): PrinterStatusReading | null {
  return readings.get(printerId) ?? null;
}

/** Record what a printer just told us. Callers pass `at` implicitly as now. */
export function setPrinterStatus(
  printerId: string,
  reading: Omit<PrinterStatusReading, "at">,
): void {
  readings.set(printerId, { ...reading, at: Date.now() });
  for (const cb of subscribers) cb();
}

/** Forget a printer's reading — after removing it, or when a connection is lost
 *  and the next reading would be a fresh negotiation anyway. */
export function clearPrinterStatus(printerId: string): void {
  if (readings.delete(printerId)) for (const cb of subscribers) cb();
}

export function subscribePrinterStatus(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/** Subscribe a component to one printer's last known reading. */
export function usePrinterStatus(printerId: string | null | undefined): PrinterStatusReading | null {
  const [, bump] = useState(0);
  useEffect(() => subscribePrinterStatus(() => bump((n) => n + 1)), []);
  return printerId ? getPrinterStatus(printerId) : null;
}

/** How to describe a reading in one short line, or null when there is nothing
 *  worth saying. Shared so the queue chip and the printers list cannot drift. */
export function describePrinterStatus(r: PrinterStatusReading | null): string | null {
  if (!r || !r.responded) return null;
  const parts: string[] = [];
  if (r.widthMm && r.heightMm) parts.push(`${r.widthMm} × ${r.heightMm} mm`);
  if (r.battery) {
    // Percent, not bars: bars matched the printer's own 5-segment display, but a
    // number reads at a glance and the fraction is a real measurement (raw
    // against the fullest charge ever observed), not bars re-scaled.
    const pct = Math.round(r.battery.fraction * 100);
    parts.push(r.battery.charging ? `charging · ${pct}%` : `battery ${pct}%`);
  }
  return parts.length ? parts.join(" · ") : null;
}

// ── the PERSISTED counterpart ───────────────────────────────────────────────
// The cache above dies with the tab, which is the right lifetime for a battery
// level. The loaded ROLL is different: it changes only when someone swaps it,
// so it is written onto the printer row and survives the printer being off, a
// reload, and a move to another computer.
//
// It lives here rather than inside the labels module because the Printers
// settings page reads it too, and a second copy over there is exactly the kind
// of drift this file already exists to prevent.

/** What a printer last reported it had loaded, from its stored settings. */
export interface ReportedMedia {
  widthMm: number;
  heightMm: number;
  at?: string;
}

export function reportedMedia(settings: Record<string, unknown> | undefined): ReportedMedia | null {
  const v = (settings ?? {}).lastReportedMediaMm as { widthMm?: unknown; heightMm?: unknown; at?: unknown } | undefined;
  if (!v || typeof v !== "object") return null;
  if (typeof v.widthMm !== "number" || typeof v.heightMm !== "number" || v.widthMm <= 0 || v.heightMm <= 0) return null;
  return { widthMm: v.widthMm, heightMm: v.heightMm, ...(typeof v.at === "string" ? { at: v.at } : {}) };
}

/** Loop guard: saving triggers a printers refetch, and an unconditional save
 *  would then save again forever. */
export function needsReportedRemember(
  settings: Record<string, unknown> | undefined,
  r: { widthMm?: number; heightMm?: number },
): boolean {
  if (!r.widthMm || !r.heightMm) return false;
  const prev = reportedMedia(settings);
  return !prev || prev.widthMm !== r.widthMm || prev.heightMm !== r.heightMm;
}

/** One line for what the printer reports it has loaded. Shared so the Labels
 *  toolbar and the Printers settings row cannot describe the same stored
 *  reading two different ways. */
export function describeReportedMedia(settings: Record<string, unknown> | undefined): string | null {
  const r = reportedMedia(settings);
  return r ? `${r.widthMm} × ${r.heightMm} mm` : null;
}
