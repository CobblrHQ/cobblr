// Pasting a picture: ONE listener for the whole app, and every place a photo
// can be added registers here.
//
// Paste worked in six places, each with its own listener (the Files list, the
// feedback form, the scan page twice, the viewer, the image search box), and
// nowhere else: not a record's photo, not a part's gallery, not a knowledge
// entry's image, not "Add photos". Six listeners on one window also meant a
// page with two of them took one paste twice. So a surface no longer listens:
// it says where it is (`area`) and what to do with a picture, and the one
// listener decides which surface a paste belongs to:
//
//   1. a paste inside a registered area goes to that area (the innermost when
//      areas nest), so a paste in the image search box is the search box's;
//   2. otherwise a paste into a text field nobody registered stays text;
//   3. otherwise the area the person last pressed or focused, if it is still
//      on screen, then the area mounted last;
// and only areas in the layer on top take part, so a dialog's own photo takes
// a paste and the page behind it never does. A paste that carries no picture
// (and no picture's address, for an area that takes one) is left alone, so
// typing is never eaten. lint:paste-goes-through-one-door holds every image
// input to this hook.
import { useEffect, useRef, type RefObject } from "react";
import { inTopLayer } from "./layer-stack";
import { acceptsFile, payloadFromClipboard, readPastedImage } from "./pastedImage";

export interface PasteImageHandlers {
  /** Files on the clipboard this area takes (`accept`). Only the first when
   *  `multiple` is false. */
  onFiles?: (files: File[]) => void;
  /** Which files the area takes, in a file input's `accept` syntax, and the
   *  same string as the area's own upload input so a paste and a chosen file
   *  can never differ (lint:paste-goes-through-one-door). Default
   *  "image/*": a picture. "*" takes any file. */
  accept?: string;
  /** The address of a picture, pasted as text. An area without it ignores one. */
  onUrl?: (url: string) => void;
  /** Text pasted onto the area itself (never into a text field: rule 2),
   *  when it carried no picture. Return true to take it; false leaves the
   *  paste alone. The inbox takes a product shared with its link this way. */
  onText?: (text: string) => boolean;
  multiple?: boolean;
  /** Default true. */
  enabled?: boolean;
}

interface Target {
  seq: number;
  area: () => HTMLElement | null;
  handlers: { current: PasteImageHandlers };
}

let nextSeq = 0;
const targets = new Set<Target>();
let lastTouched: Element | null = null;
let listening = false;

const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
/** Somewhere a paste is typing: a text box, never a file picker or a checkbox. */
function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type);
}

/** Which registered area a paste belongs to, or null. Pure over its inputs,
 *  so the rule is held by a test without a clipboard. */
export function pasteTargetFor<T extends { seq: number; area: HTMLElement }>(
  live: readonly T[],
  target: Element | null,
  touched: Element | null,
): T | null {
  const containing = (el: Element | null) =>
    el ? live.filter((t) => t.area.contains(el)).sort((a, b) => depth(b.area) - depth(a.area))[0] ?? null : null;
  const inside = containing(target);
  if (inside) return inside;
  if (isTextField(target)) return null;
  return containing(touched) ?? [...live].sort((a, b) => b.seq - a.seq)[0] ?? null;
}

function depth(el: Element): number {
  let d = 0;
  for (let n: Element | null = el; n; n = n.parentElement) d++;
  return d;
}

function onPaste(e: ClipboardEvent) {
  if (e.defaultPrevented) return;
  const live: Array<{ seq: number; area: HTMLElement; handlers: Target["handlers"] }> = [];
  for (const t of targets) {
    const area = t.area();
    if (!area || !area.isConnected || t.handlers.current.enabled === false || !inTopLayer(area)) continue;
    live.push({ seq: t.seq, area, handlers: t.handlers });
  }
  const payload = payloadFromClipboard(e.clipboardData);
  // A file goes to an area that takes it: a PDF pasted on a record finds its
  // Files list, never the photo box beside it that takes pictures only and
  // would drop it. With no area that takes the files, the paste is read for
  // what else it carries (a picture's address, text).
  const pasted = payload.files ?? [];
  const takers = pasted.length
    ? live.filter((t) => t.handlers.current.onFiles && pasted.some((f) => acceptsFile(t.handlers.current.accept ?? "image/*", f)))
    : [];
  const chosen = pasteTargetFor(takers.length ? takers : live, e.target instanceof Element ? e.target : null, lastTouched);
  if (!chosen) return;
  const h = chosen.handlers.current;
  // Files first, whatever text came with them: Finder copies a file AND its
  // name, and the name is never what was meant.
  const files = (payload.files ?? []).filter((f) => acceptsFile(h.accept ?? "image/*", f));
  if (files.length && h.onFiles) {
    e.preventDefault();
    h.onFiles(h.multiple ? [...files] : files.slice(0, 1));
    return;
  }
  const read = readPastedImage(payload);
  if (read?.kind === "url" && h.onUrl) {
    e.preventDefault();
    h.onUrl(read.url);
    return;
  }
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (text.trim() && h.onText && !isTextField(e.target instanceof Element ? e.target : null) && h.onText(text)) {
    e.preventDefault();
  }
}

function touch(e: Event) {
  if (e.target instanceof Element) lastTouched = e.target;
}

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("paste", onPaste, true);
  window.addEventListener("pointerdown", touch, true);
  window.addEventListener("focusin", touch, true);
}

/** Take pictures pasted into `area` (or pasted while it was the last thing
 *  touched). `area` is a ref, or a function for an area found at paste time. */
export function usePasteImage(area: RefObject<HTMLElement | null> | (() => HTMLElement | null), handlers: PasteImageHandlers): void {
  const current = useRef(handlers);
  current.current = handlers;
  const where = useRef(area);
  where.current = area;
  useEffect(() => {
    listen();
    const t: Target = {
      seq: ++nextSeq,
      area: () => {
        const a = where.current;
        return typeof a === "function" ? a() : a.current;
      },
      handlers: current,
    };
    targets.add(t);
    return () => {
      targets.delete(t);
    };
  }, []);
}
