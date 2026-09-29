// Where an app goes when it leaves the sidebar, said once. Hiding one here or
// turning one off makes it vanish from the nav, and nothing said where to
// find it again (#3883); the first time, a toast points at ⊞ More apps. Per
// device, a convenience: losing it only means being told again.
import { useToast } from "@cobblr/platform-web";
import { toggleNavHidden } from "./nav-order";

const TOLD = "cobblr.more-apps.told";
/** How many times the Search row reminds what it searches. */
export const SEARCH_HINT_USES = 5;
const SEARCH_USES = "cobblr.search.uses";

export function useSayWhereItWent(): () => void {
  const toast = useToast();
  return () => {
    try {
      if (localStorage.getItem(TOLD)) return;
      localStorage.setItem(TOLD, "1");
    } catch {
      // No storage: say it every time rather than never.
    }
    toast.info("It's in ⊞ More apps, at the end of your sidebar");
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
