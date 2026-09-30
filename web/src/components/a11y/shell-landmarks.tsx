// The two things every page shell owes someone who does not use a mouse or
// cannot see the screen (#4115, the shell audit):
//
//   - a "Skip to content" link, the first thing Tab reaches, so a keyboard
//     user is not walked through the whole nav (a dozen apps and the account
//     menu) on every page before reaching what the page is for;
//   - a polite announcement of the page's name after a navigation. A single
//     page app changes the page without a load, so a screen reader said
//     nothing at all when a link was followed. Focus is NOT moved to the page:
//     a record opens as a dialog on its own route, and the dialog holds focus
//     (useDialogFocus), so moving it here would take it away again.
//
// lint:every-main-can-be-skipped-to holds every <main> to MAIN_ID and every
// file that draws one to <SkipToContent/>.
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

export const MAIN_ID = "main-content";

export function SkipToContent() {
  return (
    <a
      href={`#${MAIN_ID}`}
      onClick={(e) => {
        const main = document.getElementById(MAIN_ID);
        if (!main) return;
        e.preventDefault();
        main.focus();
        main.scrollIntoView?.({ block: "start" });
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[3000] focus:rounded-md focus:bg-surface focus:dark:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-accent focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent"
    >
      Skip to content
    </a>
  );
}

/** The page's own name, from the title usePageTitle set ("Assets · cobblr"). */
export function pageNameOf(title: string): string {
  const name = title.replace(/\s*·\s*cobblr\s*$/i, "").trim();
  return /^cobblr$/i.test(name) ? "" : name;
}

/** Says the new page's name once the navigation has settled. The first page
 *  is not announced: the browser already read it on load. */
export function RouteAnnouncer({ settleMs = 400 }: { settleMs?: number }) {
  const { pathname } = useLocation();
  const [said, setSaid] = useState("");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      const name = pageNameOf(document.title);
      setSaid(name ? `${name} page` : "Page changed");
    }, settleMs);
    return () => window.clearTimeout(t);
  }, [pathname, settleMs]);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="route-announcer">
      {said}
    </div>
  );
}
