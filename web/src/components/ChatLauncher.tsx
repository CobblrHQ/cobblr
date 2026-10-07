// The header and menu button that opens Cobb or Discussion. Its own file so
// the shell can draw it on every page without loading the conversation panel
// (ChatWidget.tsx, loaded with the side panel; #4945). It holds no panel, no
// portal and no conversation state: one ChatPanel is mounted by AppLayout.

import { openDiscussion } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { CobbHead } from "./CobbHead";
import { openRail, useRailActiveTab } from "./SideRail";

/** The Ask-Cobb button alone — safe to render in as many chrome spots as the
 *  layout needs (desktop header, mobile header, sidebar row). The conversation
 *  lives in the ONE <ChatPanel> AppLayout mounts; keeping the panel out of this
 *  component is the point. It used to be bundled in (one ChatWidget = button +
 *  panel), and because the panel PORTALS to <body>, the wrappers' hidden /
 *  md:hidden gating hid only the buttons — every mounted instance's panel
 *  rendered when the shared `open` flipped, stacked, each holding its own
 *  conversation. You typed into whichever was on top; a breakpoint resize
 *  changed which one that was. */
export function ChatLauncher({ open, setOpen, asRow = false }: { open: boolean; setOpen: (v: boolean) => void; asRow?: boolean }) {
  const { activeSlug } = useActiveOrg();
  // ABOVE the guard. React identifies hooks by call order, so a hook below an
  // early return runs only on some renders — the crash this repo already has a
  // lint for, which is what caught it here.
  const activeTab = useRailActiveTab();
  if (!activeSlug) return null;

  // OPENING goes through openRail so it lands on the tab the words name.
  // Toggling the shared `open` flag alone reopens whatever tab was last used,
  // so a control labelled "Ask Cobb" could open on Pinned — which is exactly
  // what it did once the rail grew tabs.
  // ONE RULE FOR EVERY SEGMENT:
  //
  //   closed                → open on my tab
  //   open, showing my tab  → close
  //   open, showing another → SWITCH to my tab
  //
  // The third case is the one that was missing, and it made the row feel
  // broken in both directions: pressing Cobb while Discussion was showing
  // closed the panel (because "open" was read as "mine"), and pressing
  // Discussion while Discussion was showing did nothing (because it always
  // called openRail).
  const go = (tab: string) => () => {
    if (open && activeTab === tab) setOpen(false);
    // The header has no record of its own: Discussion shows the one in
    // context, or the room.
    else if (tab === "discussion") openDiscussion({ record: null });
    else openRail(tab);
  };
  const openCobb = go("cobb");

  // ── the header form: an icon, and Cobb is what it opens ─────────────
  if (!asRow) {
    return (
      <button
        type="button"
        onClick={openCobb}
        className="transition p-1.5 text-faint dark:text-slate-500 hover:text-accent"
        title={open ? "Hide Cobb" : "Ask Cobb"}
        aria-label={open ? "Hide Cobb" : "Ask Cobb"}
      >
        {/* A button labelled "Ask Cobb" should show Cobb, not a sparkle. The
            head is the mark drawn for this size — full-body is unreadable at
            18px, and it stays lit even when AI is off, because basic mode
            still answers. */}
        <CobbHead size={18} className="shrink-0" title="Cobb" />
      </button>
    );
  }

  // ── the menu form: ONE row, two ways in ─────────────────────────────
  //
  // Cobb and Discussion are two rooms behind the same door, so they share a
  // row rather than taking one each — the menu is short, and a row apiece
  // would teach that they are separate destinations when they are not. It also
  // stops "Ask Cobb" having to cover for a panel that does more than Cobb,
  // which is what made the name look wrong.
  //
  // A div of two buttons, not a button with two halves: a button inside a
  // button is invalid, and each half genuinely does its own thing.
  // gap-1.5, not 2.5: the sidebar column is 208px and "Ask Cobb | Discussion"
  // only just fits. At 2.5, with the divider's own padding, it overran and
  // "Ask Cobb" wrapped onto two lines — which reads as a mistake rather than a
  // pair. whitespace-nowrap on both halves keeps that from coming back when a
  // label changes.
  return (
    <div className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] text-muted dark:text-slate-400 hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition">
      <CobbHead size={18} className="shrink-0" title="Cobb" />
      <button
        type="button"
        onClick={openCobb}
        className="whitespace-nowrap hover:text-accent transition"
        title={open ? "Hide Cobb" : "Ask Cobb"}
        aria-label={open ? "Hide Cobb" : "Ask Cobb"}
      >
        Ask Cobb
      </button>
      {/* The divider is a TARGET too: it opens the panel on whatever you had
          last, which is what you want when you do not care which room — you
          just want the thing back. Air on both sides so at 13px it reads as
          the join between two controls rather than punctuation inside one
          phrase. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="px-1.5 text-faint/60 dark:text-slate-600 hover:text-accent select-none transition"
        title={open ? "Hide the panel" : "Reopen the panel where you left it"}
        aria-label={open ? "Hide the panel" : "Reopen the panel"}
      >
        |
      </button>
      <button
        type="button"
        onClick={go("discussion")}
        className="whitespace-nowrap hover:text-accent transition"
        title="What people are saying here"
        aria-label="Open discussion"
      >
        Discussion
      </button>
    </div>
  );
}
