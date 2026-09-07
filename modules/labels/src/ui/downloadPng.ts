// Save queued labels as PNG image files — the offline-printer path.
//
// Some label printers aren't networked and can't be driven from the app (no
// CUPS address, no Web Bluetooth/Serial), so their owner needs the label as an
// IMAGE to import into whatever software drives the printer. Each label is
// rendered with the SAME canvas renderer the thermal path uses, so what is saved
// is what a printer would print. One file downloads as a .png; more than one as
// a single .zip, because the browser blocks the second of N separate downloads.
//
// WHAT to render — copies, the code badge, the turn — is decided in
// save-png-plan.ts, which is pure and tested. This file only draws and saves.

import { downloadBlob, renderLabelPng, withPngDpi } from "@cobblr/platform-web";
import { zipFileNames, type PngPlan } from "./save-png-plan";

// 300 dpi keeps the QR and caption sharp on any printer and is written INTO the
// file (pHYs), so a 2 × 2 inch label opens as 2 × 2 inches rather than as 600 px
// at whatever the reader assumes. Label dimensions are inches.
export const PNG_DPI = 300;

// Render a few at a time. Every label at 300 dpi held at once is a canvas per
// label, and a long queue on a phone runs past the canvas memory cap, where
// Safari hands back blank images instead of an error.
const RENDER_AT_ONCE = 4;

async function renderOne(plan: PngPlan, i: number): Promise<Uint8Array<ArrayBuffer>> {
  const widthDots = Math.max(1, Math.round(plan.dims.label_w * PNG_DPI));
  const heightDots = Math.max(1, Math.round(plan.dims.label_h * PNG_DPI));
  const blob = await renderLabelPng(plan.labels[i]!.content, widthDots, heightDots);
  return withPngDpi(new Uint8Array(await blob.arrayBuffer()), PNG_DPI);
}

/** Render every label in the plan and download the result. Returns the number
 *  of label files written: one .png for a single copy, else one .zip holding
 *  every copy. */
export async function downloadLabelsAsPng(plan: PngPlan): Promise<number> {
  if (plan.labels.length === 0) return 0;

  // Rendered once per DESIGN; a copy is the same bytes under another name.
  const pngs: Uint8Array<ArrayBuffer>[] = new Array(plan.labels.length);
  for (let start = 0; start < plan.labels.length; start += RENDER_AT_ONCE) {
    const batch = plan.labels.slice(start, start + RENDER_AT_ONCE).map((_, k) => renderOne(plan, start + k));
    const done = await Promise.all(batch);
    done.forEach((png, k) => { pngs[start + k] = png; });
  }

  const names = zipFileNames(plan.labels);
  if (names.length === 1) {
    downloadBlob(new Blob([pngs[0]!], { type: "image/png" }), names[0]!.name);
    return 1;
  }

  // The zip library only ships to the people who zip: the one-label case above
  // is the common one and never needs it.
  const { zipSync } = await import("fflate");
  const files: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const { name, index } of names) files[name] = pngs[index]!;
  // level 0: PNGs are already compressed, so deflate only costs time.
  // fflate types its output as ArrayBufferLike; it is a plain ArrayBuffer in practice.
  const zip = zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>;
  downloadBlob(new Blob([zip], { type: "application/zip" }), "cobblr-labels.zip");
  return names.length;
}
