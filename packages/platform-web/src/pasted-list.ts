// The one door a one-line add box reads a pasted list through (#4115).
//
// A one-line box folds a paste's lines into one, so a shopping list copied
// from Notes became one item. A box that adds things spreads these props:
// a paste of two or more lines is handed over one thing per line (bullets,
// checkboxes and numbering gone, counts apart), and a one-line paste goes
// into the box as it always did. Pictures are usePasteImage's.

import type { ClipboardEvent } from "react";
import { readPastedList, type PastedLine } from "@cobblr/platform-contract/pasted-lines";

export function pastedListProps(onList: (lines: PastedLine[]) => void) {
  return {
    onPaste: (e: ClipboardEvent<HTMLInputElement>) => {
      const list = readPastedList(e.clipboardData.getData("text/plain"));
      if (!list) return;
      e.preventDefault();
      onList(list);
    },
  };
}
