// A dialog holds the keyboard while it is open, and gives it back when it
// closes: the three things WAI-ARIA asks of a modal dialog and that no
// dialog here did (#4115). Without them, Tab from the last button walked out
// into the page behind the backdrop (links nobody could see, a form under the
// blur), a screen reader started reading the page instead of the dialog, and
// closing one dropped focus to the top of the document, so a keyboard user
// lost their place on every confirm.
//
//   - Opening moves focus in: to whatever the dialog already focused (an
//     autoFocus field), else the dialog itself, so a screen reader reads it
//     and the next Tab is its first control.
//   - Tab and Shift+Tab wrap at the ends, and a Tab from outside (after a
//     click on the backdrop) comes back in. Only the TOP layer does this
//     (layer-stack), so a confirm opened over a modal holds the keys and the
//     modal under it does not pull them back; and a surface marked
//     data-modal-escape-exempt (the docked Ask Cobb panel, which coexists
//     with dialogs) keeps focus when you move there on purpose.
//   - Closing puts focus back on what had it when the dialog opened. A page
//     that drew its list again while the dialog was up (a record's detail is
//     its own address, and the list behind it mounts afresh) has the same
//     control under a new element: the one with the same id, link or test id
//     that a person can see is focused instead, so the next Tab carries on
//     from that row rather than from the top of the page (#7847).
import { useEffect, useRef, type RefObject } from "react";
import { isTopLayer } from "./layer-stack";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The controls a Tab can land on inside `root`, in order. Ones inside an
 *  [inert]/[hidden] subtree are skipped, and so are ones with no box, when
 *  the page has layout at all (a root with no box is a test document). */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const laidOut = root.getClientRects().length > 0;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[inert],[hidden]") && (!laidOut || el.getClientRects().length > 0 || el === document.activeElement),
  );
}

/** `panel` is the dialog's own box (focus lives inside it); `layer` is the
 *  element registered with the layer stack (the overlay), which says whether
 *  this dialog is the one on top. They may be the same element. */
/** How to find `el` again once the page has drawn it anew: its id, else a
 *  link's address, else its test id. Null for a control with none of them. */
function findAgain(el: HTMLElement): (() => HTMLElement | null) | null {
  const esc = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"));
  const tag = el.tagName.toLowerCase();
  const selector = el.id
    ? `#${esc(el.id)}`
    : el.getAttribute("href")
      ? `${tag}[href="${esc(el.getAttribute("href")!)}"]`
      : el.dataset.testid
        ? `${tag}[data-testid="${esc(el.dataset.testid)}"]`
        : null;
  if (!selector) return null;
  return () => {
    const all = [...document.querySelectorAll<HTMLElement>(selector)];
    return all.find((c) => c.getClientRects().length > 0) ?? all[0] ?? null;
  };
}

/** Focus `opener`, or the control that took its place, once the page has it. */
function giveBack(opener: HTMLElement, again: (() => HTMLElement | null) | null): void {
  if (opener.isConnected) {
    opener.focus();
    return;
  }
  if (!again || typeof requestAnimationFrame === "undefined") return;
  let frames = 0;
  const look = () => {
    const now = document.activeElement;
    if (now && now !== document.body) return;
    const found = again();
    if (found) found.focus();
    else if (++frames < 30) requestAnimationFrame(look);
  };
  look();
}

export function useDialogFocus(open: boolean, panel: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null> = panel): void {
  // Who had focus is read while RENDERING the open dialog, before React
  // commits it: by the time an effect runs, a control inside marked autoFocus
  // (the confirm's OK) already has focus, and "the opener" would be the
  // dialog's own button, gone when it closes.
  const openerRef = useRef<HTMLElement | null>(null);
  const againRef = useRef<(() => HTMLElement | null) | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    againRef.current = openerRef.current && openerRef.current !== document.body ? findAgain(openerRef.current) : null;
  }
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const opener = openerRef.current;
    const again = againRef.current;
    const box = panel.current;
    if (box && !box.contains(document.activeElement)) {
      // The dialog itself, not its first field: focusing a text box on open
      // raises a phone's keyboard over the dialog nobody has read yet. A field
      // that wants the keys says autoFocus and already has them.
      if (!box.hasAttribute("tabindex")) box.setAttribute("tabindex", "-1");
      box.classList.add("outline-none");
      box.focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const root = panel.current;
      const top = layer.current ?? root;
      if (!root || !top || !isTopLayer(top)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[data-modal-escape-exempt]")) return;
      const items = tabbables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        root.focus();
        return;
      }
      if (!root.contains(active) || active === root) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Give focus back only when the dialog still had it (or nobody does):
      // a dialog closed because the user clicked somewhere else keeps that.
      const now = document.activeElement;
      const lost = !now || now === document.body || (box?.contains(now) ?? false) || !now.isConnected;
      if (lost && opener) giveBack(opener, again);
    };
  }, [open, panel, layer]);
}
