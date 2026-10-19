// Which printer should print this? (Services §14.3, #4034.)
//
// The rule, in order: the part has to FIT, then a printer already loaded with
// enough of the right filament beats one that would need a spool change, then
// an idle printer beats a busy one, and last the order the person set their
// pools in. Nothing here sends anything: this only answers and says why, so a
// person (or Cobb, before the one confirm card) can see the choice.
//
// Pure: the handler gathers the candidates (linked devices, their Printing
// profiles, the spools placed in their slots, live state, pool order) and this
// ranks them, so the rule is tested without a farm.

import { withArticle } from "@cobblr/platform-contract/plural";
import type { LoadedSpool, PrinterCandidate, PrintingProfile } from "../../core/printing.js";

export type { LoadedSpool, PrinterCandidate, PrintingProfile } from "../../core/printing.js";


export interface PrintAsk {
  material: string;
  color?: string | null;
  /** Null before a slice has said how much it needs (Print this ranks first,
   *  then slices for the printer it chose): "enough left" is then not known. */
  grams: number | null;
  /** Null when the part's size is not known (a 3MF with no report). */
  bbox_mm: [number, number, number] | null;
  nozzle_mm?: number | null;
}



export interface PickedPrinter {
  machine: PrinterCandidate["machine"];
  device: PrinterCandidate["device"];
  idle: boolean;
  /** Null when the printer has no build volume on its Printing profile. */
  fits: boolean | null;
  loaded: { spool: LoadedSpool["spool"]; slot: string | null; color_match: boolean; grams_left: number | null; values?: Record<string, unknown> } | null;
  profile: { printer_model: string | null; nozzle_mm: number | null; quality: string | null; preset_hint: string | null } | null;
  /** False when this printer cannot take the job as asked (wrong nozzle). */
  usable: boolean;
  reason: string;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Same colour, by name or by code, ignoring case and a leading "#". */
export function sameColour(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a).replace(/^#/, "");
  const y = norm(b).replace(/^#/, "");
  return !!x && x === y;
}

/** Does a part of this size fit this build volume? Turning it on the bed
 *  (swapping X and Y) is allowed; standing it up is not, since the part
 *  arrives oriented for printing. */
export function partFits(bbox: [number, number, number] | null, volume: [number, number, number] | null): boolean | null {
  if (!volume || !bbox) return null;
  const [x, y, z] = bbox;
  const [X, Y, Z] = volume;
  if (z > Z) return false;
  return (x <= X && y <= Y) || (x <= Y && y <= X);
}

/** The best spool on the printer for this ask, and how good a match it is:
 *  0 the right material and colour with enough left, 1 right but how much is
 *  left is unknown, 2 the material without the colour or without enough,
 *  3 nothing that helps. */
function bestLoaded(ask: PrintAsk, loaded: LoadedSpool[]): { spool: LoadedSpool | null; grade: number; colorMatch: boolean } {
  let best: { spool: LoadedSpool | null; grade: number; colorMatch: boolean } = { spool: null, grade: 3, colorMatch: false };
  for (const s of loaded) {
    if (norm(s.material) !== norm(ask.material)) continue;
    const colorMatch = ask.color ? sameColour(s.color, ask.color) : true;
    const enough = s.grams_left == null || ask.grams == null ? null : s.grams_left >= ask.grams;
    const grade = colorMatch && enough === true ? 0 : colorMatch && enough === null ? 1 : 2;
    if (grade < best.grade) best = { spool: s, grade, colorMatch };
  }
  return best;
}

function reasonFor(ask: PrintAsk, c: PrinterCandidate, fits: boolean | null, pick: ReturnType<typeof bestLoaded>, usable: boolean): string {
  const parts: string[] = [];
  if (!usable) parts.push(`has ${withArticle(`${c.profile?.nozzle_mm} mm`)} nozzle, the job asks ${ask.nozzle_mm} mm`);
  const v = c.profile?.build_volume_mm;
  if (fits === true) parts.push("the part fits");
  else if (fits === false) parts.push(`the part does not fit (${ask.bbox_mm?.join("×")} mm on ${v?.join("×")} mm)`);
  else if (!ask.bbox_mm) parts.push("the part's size is not known");
  else parts.push("no build volume on its Printing profile");
  const s = pick.spool;
  if (s && pick.grade === 0) parts.push(`${s.material}${s.color ? ` ${s.color}` : ""} loaded${s.slot ? ` in slot ${s.slot}` : ""}, ${Math.round(s.grams_left ?? 0)} g left`);
  else if (s && pick.grade === 1) parts.push(`${s.material}${s.color ? ` ${s.color}` : ""} loaded${s.slot ? ` in slot ${s.slot}` : ""}${ask.grams == null && s.grams_left != null ? `, ${Math.round(s.grams_left)} g left` : ", amount left not known"}`);
  else if (s && !pick.colorMatch) parts.push(`${s.material} loaded, but not ${ask.color}`);
  else if (s) parts.push(`${s.material} loaded, ${Math.round(s.grams_left ?? 0)} g left, ${ask.grams} g needed`);
  else parts.push(`no ${ask.material}${ask.color ? ` ${ask.color}` : ""} loaded`);
  parts.push(c.idle ? "idle" : "busy");
  return parts.join("; ");
}

/** Rank every candidate, best first. None is dropped: a printer the part does
 *  not fit, or with the wrong nozzle, stays in the list at the end with its
 *  reason, so the answer says why it was not chosen. */
export function rankPrinters(ask: PrintAsk, candidates: readonly PrinterCandidate[]): PickedPrinter[] {
  const scored = candidates.map((c) => {
    const fits = partFits(ask.bbox_mm, c.profile?.build_volume_mm ?? null);
    const usable = !(ask.nozzle_mm && c.profile?.nozzle_mm && Math.abs(c.profile.nozzle_mm - ask.nozzle_mm) > 1e-6);
    const pick = bestLoaded(ask, c.loaded);
    const hint = pick.spool?.type_id ? (c.profile?.preset_hints?.[pick.spool.type_id] ?? null) : null;
    const picked: PickedPrinter = {
      machine: c.machine,
      device: c.device,
      idle: c.idle,
      fits,
      loaded: pick.spool ? { spool: pick.spool.spool, slot: pick.spool.slot, color_match: pick.colorMatch, grams_left: pick.spool.grams_left, values: pick.spool.values } : null,
      profile: c.profile
        ? { printer_model: c.profile.printer_model, nozzle_mm: c.profile.nozzle_mm, quality: c.profile.default_quality, preset_hint: hint }
        : null,
      usable,
      reason: reasonFor(ask, c, fits, pick, usable),
    };
    const key = [
      usable ? 0 : 1,
      fits === true ? 0 : fits === null ? 1 : 2,
      pick.grade,
      c.idle ? 0 : 1,
      c.pool_order ?? Number.MAX_SAFE_INTEGER,
    ];
    return { picked, key, name: (c.machine.label ?? c.device.name ?? "").toLowerCase() };
  });
  scored.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
    return a.name.localeCompare(b.name);
  });
  return scored.map((s) => s.picked);
}
