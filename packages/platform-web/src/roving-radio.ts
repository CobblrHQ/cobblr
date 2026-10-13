// The keyboard of a radio group, in one place (#6160).
//
// A row of role="radio" buttons is one tab stop: Tab lands on the picked
// option (or the first one when nothing is picked), and the arrow keys move to
// the next option that can be picked, wrapping at the ends, and pick it. Each
// hand-built group used to set role and aria-checked and stop there, so every
// option was its own tab stop and the arrows did nothing: a screen reader
// announced a radio group that did not behave as one.
//
// A plain function, not a hook, so a group drawn inside a .map() (one per
// conflict, one per field) can use it too. It moves through the DOM: the next
// enabled [role=radio] in the closest [role=radiogroup] is focused and clicked,
// so the option's own onClick does the picking. SegmentedChoice and every
// hand-built group spread what this returns; lint:radio-groups-rove holds them
// to it.
import type { KeyboardEvent, MouseEvent } from "react";

export interface RovingRadioProps {
  tabIndex: 0 | -1;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onClickCapture: (e: MouseEvent<HTMLElement>) => void;
}

const STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Props for option `i` of a radio group whose picked option is `picked`
 *  (-1 when none is). */
export function rovingRadio(i: number, picked: number): RovingRadioProps {
  return {
    tabIndex: i === (picked >= 0 ? picked : 0) ? 0 : -1,
    onKeyDown: (e) => {
      const dir = STEP[e.key];
      if (!dir) return;
      const group = e.currentTarget.closest('[role="radiogroup"]');
      if (!group) return;
      e.preventDefault();
      const options = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
        (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true",
      );
      if (options.length === 0) return;
      const at = options.indexOf(e.currentTarget);
      const next = options[(at + dir + options.length) % options.length]!;
      next.focus();
      next.click();
    },
    // Every pick is a click (a tap, Space, Enter, or the arrow's own), and a
    // save that follows it can take the focus.
    onClickCapture: (e) => {
      const group = e.currentTarget.closest('[role="radiogroup"]');
      if (group) keepFocusThroughSave(group, e.currentTarget);
    },
  };
}

/** How long a save may hold the group disabled before focus is let go. */
const SAVE_WINDOW_MS = 15_000;

/** A group that saves its pick disables its options while the save runs, and a
 *  browser drops the focus of a disabled button to <body>: the next arrow then
 *  went nowhere (#6212, the account's title format). Watch the group until the
 *  save is over, and when focus has fallen to <body> and the chosen option can
 *  take it again, give it back. Focus the person moved elsewhere is left
 *  alone. */
function keepFocusThroughSave(group: Element, chosen: HTMLElement): void {
  if (typeof MutationObserver === "undefined") return;
  const restore = () => {
    const active = group.ownerDocument.activeElement;
    // Still on an option: the save has not taken it yet, keep watching.
    if (active && group.contains(active)) return;
    // Moved somewhere else on purpose: not ours to take back.
    if (active && active !== group.ownerDocument.body) return stop();
    // The option the person chose, not the one marked checked: a group can
    // come back enabled before the saved value is read again, and the old
    // pick is still the checked one for that moment.
    const picked = chosen.isConnected ? chosen : group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (!picked || (picked as HTMLButtonElement).disabled || picked.getAttribute("aria-disabled") === "true") return;
    picked.focus();
    stop();
  };
  const watch = new MutationObserver(restore);
  const timer = setTimeout(() => stop(), SAVE_WINDOW_MS);
  function stop() {
    watch.disconnect();
    clearTimeout(timer);
  }
  watch.observe(group, { subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "aria-checked"] });
}
