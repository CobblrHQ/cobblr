// Back never throws away what a person typed into a record form (#4115).
//
// On a phone, Back is a gesture: an iPhone's swipe from the left edge, an
// Android back. A person half way through a new part swiped, the page went
// back, the form went with it, and what they had typed was gone without a word
// (walked on an iPhone and an Android phone). So a record form that has been
// typed into puts one entry of its own on the browser's history, at the same
// address. Back then lands on the form's entry instead of leaving the page,
// and the form asks first: keep editing, or discard and go back. A form that
// closes any other way (saved, cancelled, its close button) takes its entry
// off again, unless the page has already moved on (a save that opens the new
// record), so Back after it goes where it always went.

import { useCallback, useEffect, useId, useRef } from "react";
import { useConfirm } from "./ConfirmContext";

const KEY = "cobblrTypingKept";

function current(id: string): boolean {
  return typeof history !== "undefined" && (history.state as Record<string, unknown> | null)?.[KEY] === id;
}

/** While `active`, after `arm()` is called (the first keystroke), Back asks
 *  before it discards. `close(then)` takes the form's history entry off first
 *  and then runs `then`, for the form's own ways of closing. */
export function useBackKeepsTyping(active: boolean, onDiscard: () => void): { arm: () => void; close: (then: () => void) => void } {
  const id = useId();
  const armed = useRef(false);
  const asking = useRef(false);
  const confirm = useConfirm();
  const discard = useRef(onDiscard);
  discard.current = onDiscard;

  const push = useCallback(() => {
    history.pushState({ ...((history.state as object | null) ?? {}), [KEY]: id }, "", location.href);
  }, [id]);

  const arm = useCallback(() => {
    if (!active || armed.current || typeof history === "undefined") return;
    armed.current = true;
    push();
  }, [active, push]);

  useEffect(() => {
    if (!active) return;
    const onPop = () => {
      if (!armed.current || current(id) || asking.current) return;
      // Back took the form's entry off: the page is still here, so ask.
      asking.current = true;
      void confirm({
        title: "Discard what you typed?",
        message: "Going back closes this form, and what you typed in it is not saved.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      }).then((ok) => {
        asking.current = false;
        if (!ok) {
          push();
          return;
        }
        armed.current = false;
        discard.current();
        history.back();
      });
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed some other way: take the entry off, unless the page moved on.
      if (armed.current) {
        armed.current = false;
        requestAnimationFrame(() => {
          if (current(id)) history.back();
        });
      }
    };
  }, [active, id, confirm, push]);

  const close = useCallback(
    (then: () => void) => {
      if (!armed.current || !current(id)) {
        armed.current = false;
        then();
        return;
      }
      armed.current = false;
      const done = () => {
        window.removeEventListener("popstate", done);
        then();
      };
      window.addEventListener("popstate", done);
      history.back();
    },
    [id],
  );

  return { arm, close };
}
