// Where an app goes when it leaves the sidebar, said once. Hiding one here or
// turning one off makes it vanish from the nav, and nothing said where to
// find it again (#3883); the first time, a toast points at ⊞ More apps. Per
// device, a convenience: losing it only means being told again.
import { useToast } from "@cobblr/platform-web";
import { restoreSidebar, setInSidebar, sidebarSnapshot, toggleNavHidden } from "./nav-order";
import { useNavLayout, type NavLayout } from "./nav-mode";
import { useIsDesktopWidth } from "./useIsDesktopWidth";

const TOLD = "cobblr.more-apps.told";
/** How many times the Search row reminds what it searches. */
export const SEARCH_HINT_USES = 5;
const SEARCH_USES = "cobblr.search.uses";

/** Where the apps door is on THIS screen, in the words for it: a phone has a
 *  menu, not a sidebar, and the top bar's door is a chip, not a row. The
 *  toast said "the end of your sidebar" to people holding a phone (#4143). */
export function whereAppsLive(desktop: boolean, layout: NavLayout): string {
  if (!desktop) return "It's in ⊞ More apps, at the end of the menu";
  if (layout === "top") return "It's under ⊞ at the end of the top bar";
  return "It's in ⊞ More apps, at the end of your sidebar";
}

/** What this screen calls the nav: a phone has a menu, a desk a top bar or a
 *  sidebar. */
export function navWord(desktop: boolean, layout: NavLayout): "menu" | "top bar" | "sidebar" {
  if (!desktop) return "menu";
  return layout === "top" ? "top bar" : "sidebar";
}

/** How to find an app from anywhere: the shortcut at a keyboard, the Search
 *  row on a phone. */
export function howToFindAnyApp(desktop: boolean): string {
  return desktop ? "Open them here, or find any of them with ⌘K." : "Open them here, or find any of them with Search in the menu.";
}

export function useSayWhereItWent(): () => void {
  const toast = useToast();
  const desktop = useIsDesktopWidth();
  const layout = useNavLayout();
  return () => {
    try {
      if (localStorage.getItem(TOLD)) return;
      localStorage.setItem(TOLD, "1");
    } catch {
      // No storage: say it every time rather than never.
    }
    toast.info(whereAppsLive(desktop, layout));
  };
}

/** Whether the Search row still says what it finds ("apps, things,
 *  settings"): the first few times, until it has been opened that often. */
export function searchHintShown(): boolean {
  try {
    return Number(localStorage.getItem(SEARCH_USES) ?? "0") < SEARCH_HINT_USES;
  } catch {
    return true;
  }
}

export function noteSearchUsed(): void {
  try {
    localStorage.setItem(SEARCH_USES, String(Number(localStorage.getItem(SEARCH_USES) ?? "0") + 1));
  } catch {
    // A hint that stays is harmless.
  }
}

/** Hide an entry from this sidebar (or show it again). The first time
 *  something is hidden, it says where it went. */
export function useToggleNavHidden(): (slug: string, name: string) => void {
  const say = useSayWhereItWent();
  return (slug, name) => {
    if (toggleNavHidden(slug, name)) say();
  };
}

/** The pin on an app: into this sidebar or out of it, through the one rule
 *  (setInSidebar), with an Undo that puts back exactly what was there. */
export function useSidebarPin(): (slug: string, app: { label: string; names: readonly string[] }, inSidebar: boolean) => void {
  const toast = useToast();
  const word = navWord(useIsDesktopWidth(), useNavLayout());
  return (slug, app, inSidebar) => {
    const before = sidebarSnapshot(slug);
    setInSidebar(slug, app.names, inSidebar);
    toast.action(inSidebar ? `${app.label} is in your ${word} now.` : `${app.label} is out of your ${word}.`, {
      actionLabel: "Undo",
      duration: 7000,
      onAction: () => restoreSidebar(slug, before),
    });
  };
}
