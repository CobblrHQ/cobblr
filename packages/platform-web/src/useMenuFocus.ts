// A menu holds the keyboard while it is open, and gives it back when it
// closes: what WAI-ARIA asks of a menu button, and what the menus here did
// not (#8423). An inbox's More actions and the account menu opened their
// choices at the end of the document and left focus on the button behind
// them: Arrow Down scrolled the page instead of choosing (#8163, #8202).
//
//   - Opening moves focus to the first choice.
//   - Arrow Down and Arrow Up move between the choices, wrapping at the ends;
//     Home and End go to the first and the last. Tab moves the same way, so
//     focus stays in the menu until it closes.
//   - Closing (Escape, a choice, a press outside) puts focus back on the
//     button that opened it, when focus was in the menu or nowhere.
//
// Escape itself is useEscapeToClose's: the menu passes its own close to it.
// lint:menus-take-the-keyboard holds every role="menu" to this hook.
import { useEffect, useRef, type RefObject } from "react";

const CHOICE = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const PRESSABLE = 'button:not([disabled]), a[href], [role="button"]';

/** The choices a key can move to inside `menu`, in order: its menu items, or,
 *  in a menu that does not mark them, its buttons and links. A choice the
 *  screen size hides (a phone-only filter line on a desk) is not one: focus
 *  sent to it goes nowhere, and the inbox's More actions left focus on its
 *  button so (#8423). */
export function menuChoices(menu: HTMLElement): HTMLElement[] {
  const marked = [...menu.querySelectorAll<HTMLElement>(CHOICE)];
  const all = marked.length ? marked : [...menu.querySelectorAll<HTMLElement>(PRESSABLE)];
  return all.filter((el) => el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled && !el.closest("[inert],[hidden]") && (el.checkVisibility?.() ?? true));
}

/** While `open`, the menu in `menu` takes the keyboard (see above). */
export function useMenuFocus(open: boolean, menu: RefObject<HTMLElement | null>): void {
  // Who had focus when the menu opened, read while rendering it open: by the
  // effect, focus may already be inside it.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let tries = 0;
    let el: HTMLElement | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (!el) return;
      const choices = menuChoices(el);
      if (!choices.length) return;
      const at = choices.indexOf(document.activeElement as HTMLElement);
      let next: number | null = null;
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) next = at < 0 ? 0 : (at + 1) % choices.length;
      else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) next = at < 0 ? choices.length - 1 : (at - 1 + choices.length) % choices.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = choices.length - 1;
      if (next === null) return;
      e.preventDefault();
      choices[next]!.focus();
    };
    // A portaled menu mounts a frame or two after its open state.
    const take = () => {
      el = menu.current;
      if (!el) {
        if (tries++ < 10) frame = requestAnimationFrame(take);
        return;
      }
      el.addEventListener("keydown", onKey);
      if (!el.contains(document.activeElement)) menuChoices(el)[0]?.focus();
    };
    take();
    return () => {
      cancelAnimationFrame(frame);
      el?.removeEventListener("keydown", onKey);
      const back = opener.current;
      const active = document.activeElement;
      // Back to the button, unless the person has already moved elsewhere.
      if (back?.isConnected && (!active || active === document.body || (el && el.contains(active)) || !active.isConnected)) back.focus();
    };
  }, [open, menu]);
}
