// What a Save PNG press actually produces, decided in one place with no DOM.
//
// The first version of Save PNG mapped over the queue rows and handed each one
// to the renderer. That quietly disagreed with the button beside it three ways:
//
//   copies   "Print 5" expands the ×N stepper; the save produced one file
//   badge    the preview and the server draw the code pill only when the kind
//            has not opted out; the save drew it unconditionally
//   turn     a landscape face auto-rotates in the preview and ⌘P; the save
//            rendered it unturned, so the file was laid out differently from
//            the preview the person had just looked at
//
// All three are the same mistake: a fourth copy of a rule that already lived
// in three places. So this is the ONE derivation, and it is pure so the three
// facts above can be asserted as outcomes rather than trusted.

import type { LabelContent } from "@cobblr/platform-web";

export interface QueuedForPng {
  entity_id: string;
  module_name: string;
  entity_type: string;
  description: string | null;
  qr_payload: string;
  qty: number;
}

export interface PngLabel {
  content: LabelContent;
  /** Filename stem (no extension). Collisions are settled by zipFileNames. */
  name: string;
  /** How many copies the queue asked for — rendered once, written this many times. */
  copies: number;
}

export interface PngPlan {
  /** Face dimensions in inches, already TURNED when rotate applies. */
  dims: { label_w: number; label_h: number };
  labels: PngLabel[];
  /** Sum of copies: what the zip holds, and what the toast should say. */
  total: number;
}

// Windows refuses these as file names outright, extension or not.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Turn an entity's description/code into a stem any filesystem and any unzip
 *  tool will accept. Conservative: the file is going somewhere we cannot see. */
export function labelFileStem(description?: string | null, code?: string | null): string {
  const raw = (description || code || "label").trim();
  let cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, " ") // control characters: some zip tools reject them
    .replace(/[/\\?%*:|"<>]/g, "-") // characters no filesystem accepts
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim()
    .replace(/^\.+/, "") // a leading dot is a hidden file on macOS/Linux
    .replace(/[. ]+$/, ""); // Windows strips trailing dots/spaces and then collides
  if (RESERVED.test(cleaned)) cleaned = `${cleaned}-label`;
  return cleaned || "label";
}

export function planLabelPngs(input: {
  items: readonly QueuedForPng[];
  /** entity_id → code, as the codes query returns it. */
  codes: Readonly<Record<string, string>>;
  /** `${module}:${entity_type}` → draw the code in the QR centre (default true). */
  overlay: Readonly<Record<string, boolean>>;
  dims: { label_w: number; label_h: number };
  /** The queue's effectiveRotate: the face is landscape and the turn applies. */
  rotate: boolean;
  liveUrl: (payload: string) => string;
}): PngPlan {
  // A turned label IS a portrait image: the sheet renderer lays out against the
  // swapped face and turns the cell, and the canvas renderer picks its layout
  // from the aspect it is given, so swapping here reproduces the same
  // arrangement (caption above the QR) without a rotation step.
  const dims = input.rotate
    ? { label_w: input.dims.label_h, label_h: input.dims.label_w }
    : { label_w: input.dims.label_w, label_h: input.dims.label_h };

  const labels = input.items.map((it) => {
    const overlayOn = input.overlay[`${it.module_name}:${it.entity_type}`] ?? true;
    const code = overlayOn ? input.codes[it.entity_id] : undefined;
    return {
      content: {
        qrPayload: input.liveUrl(it.qr_payload),
        caption: it.description || undefined,
        centerCode: code || undefined,
      },
      name: labelFileStem(it.description, input.codes[it.entity_id]),
      copies: Math.max(1, Math.floor(it.qty || 1)),
    };
  });
  return { dims, labels, total: labels.reduce((n, l) => n + l.copies, 0) };
}

/** One filename per COPY, and no two the same.
 *
 *  Keyed on the names actually handed out, not on the source stem: a label that
 *  is genuinely called "Widget (2)" used to collide with the "(2)" the counter
 *  generated for a second "Widget", and the later one silently overwrote the
 *  earlier in the zip while the count still said both were there. */
export function zipFileNames(labels: readonly PngLabel[]): Array<{ name: string; index: number }> {
  const taken = new Set<string>();
  const out: Array<{ name: string; index: number }> = [];
  labels.forEach((l, index) => {
    for (let c = 0; c < l.copies; c++) {
      let n = 1;
      let name = `${l.name}.png`;
      while (taken.has(name)) {
        n += 1;
        name = `${l.name} (${n}).png`;
      }
      taken.add(name);
      out.push({ name, index });
    }
  });
  return out;
}
