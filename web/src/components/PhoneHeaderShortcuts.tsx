// Search and notifications in the phone's header bar.
//
// On a phone the header search bar and the bell are desktop-only, so both
// lived behind the menu: finding a thing or seeing what you missed took a
// press to open the menu and another to leave the page. The phone header now
// carries them as icons: search opens the same palette as the desktop's
// search row and Cmd/Ctrl+K, and the bell opens as the full-width sheet the
// bell already uses on a narrow screen.

import { Search } from "lucide-react";
import { NotificationsBell } from "./NotificationsBell";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";

export function PhoneHeaderShortcuts({ search = true }: { search?: boolean }) {
  return (
    <>
      {search && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
          aria-label="Search"
          title="Search"
          className="text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-100 transition p-1.5"
        >
          <Search size={16} />
        </button>
      )}
      <NotificationsBell panelOnly />
    </>
  );
}
