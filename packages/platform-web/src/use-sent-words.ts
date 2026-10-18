// A send that lands clears only the words it sent.
//
// A text box stays editable while what it held is on its way, so a person on
// a slow connection sends one comment and starts the next. The send's
// onSuccess ran `setDraft("")` regardless, and the next comment vanished,
// unsent (#7167). So a box that is cleared when its send lands says what it
// held when it was sent (`sending()`), and the success handler clears it only
// when it still holds exactly that (`landed()`). A form with several fields
// passes a snapshot of all of them. A send that did not come from the box (a
// one-click install beside a paste box) never marks it, so it never clears
// it. lint:a-landed-send-clears-only-its-own-words holds every textarea
// cleared in an onSuccess to this.

import { useMemo, useRef } from "react";

const NOTHING_SENT = Symbol("nothing sent");

export interface SentWords {
  /** Remember what the box holds now, as it is sent. */
  sending(): void;
  /** True when the box still holds what was last sent, so clearing it loses
   *  nothing. Answers once per send: after it, nothing is marked sent. */
  landed(): boolean;
}

export function useSentWords<T>(value: T): SentWords {
  const now = useRef(value);
  now.current = value;
  const sent = useRef<T | typeof NOTHING_SENT>(NOTHING_SENT);
  return useMemo<SentWords>(
    () => ({
      sending() {
        sent.current = now.current;
      },
      landed() {
        const same = sent.current !== NOTHING_SENT && Object.is(sent.current, now.current);
        sent.current = NOTHING_SENT;
        return same;
      },
    }),
    [],
  );
}
