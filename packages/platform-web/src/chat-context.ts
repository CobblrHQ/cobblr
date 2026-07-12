// Page context for Ask Cobb. The screen the user is looking at publishes a short
// summary of itself; the chat widget reads it at send-time and passes it to the
// chat endpoint, which injects it into Cobb's system prompt for situational
// relevance ("you're on the Scan Inbox — 19 pending, 16 waiting 2d+"). Lives in
// platform-web so BOTH core pages and module UIs can publish. Read at send-time
// (no React re-render plumbing): a page just publishes while mounted.

import { useEffect } from "react";

export interface ChatPageContext {
  /** Human page name, e.g. "Scan Inbox". */
  label: string;
  /** One-line state of what's on screen, e.g. "19 pending, 16 waiting 2d+". */
  summary?: string;
}

let current: ChatPageContext | null = null;

/** What Cobb should be told the user is looking at right now (or null). */
export function getChatPageContext(): ChatPageContext | null {
  return current;
}

/** A page publishes its context for as long as it's mounted; cleared on unmount.
 *  Cleanup only clears if WE are still the current publisher, so a page that
 *  unmounts AFTER the next page mounted (route transition) can't clobber it. */
export function usePublishChatContext(ctx: ChatPageContext | null): void {
  const label = ctx?.label ?? "";
  const summary = ctx?.summary ?? "";
  useEffect(() => {
    const mine: ChatPageContext | null = label ? { label, ...(summary ? { summary } : {}) } : null;
    current = mine;
    return () => {
      if (current === mine) current = null;
    };
  }, [label, summary]);
}
