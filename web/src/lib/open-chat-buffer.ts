// The last "open the chat" request, kept for a Cobb panel that is not loaded
// yet. The panel's code loads after the page has drawn (#4945), so a press of
// Ask Cobb in the first moments would otherwise reach no listener and lose
// what it asked for (the placeholder, the starter, Cobb's opener). This is
// loaded with the shell; the panel takes what is waiting when it mounts.

export interface OpenChatDetail {
  seed?: string;
  prefill?: string;
  opener?: string;
}

let waiting: OpenChatDetail | null = null;
let panelListening = false;

if (typeof window !== "undefined") {
  window.addEventListener("cobblr:open-chat", (e) => {
    if (!panelListening) waiting = (e as CustomEvent<OpenChatDetail>).detail ?? {};
  });
}

/** The panel is mounted and hears requests itself from now on; returns what
 *  was asked before it arrived, once. */
export function panelArrived(): OpenChatDetail | null {
  panelListening = true;
  const d = waiting;
  waiting = null;
  return d;
}

export function panelLeft(): void {
  panelListening = false;
}
