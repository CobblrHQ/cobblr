// What Cobblr shows when it is opened offline on a device that has not kept
// the session yet (#4226): its own screen, not the browser's "no internet"
// page, and not the sign-in page (you are still signed in). It tries again by
// itself the moment the device is back online.
import { useEffect } from "react";
import { WifiOff } from "lucide-react";
import { CobblestoneMark } from "../CobblestoneMark";
import { MAIN_ID, SkipToContent } from "./a11y/shell-landmarks";

export function OfflineScreen() {
  useEffect(() => {
    const back = () => window.location.reload();
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);
  return (
    <>
    <SkipToContent />
    <main id={MAIN_ID} tabIndex={-1} data-testid="offline-screen" className="min-h-screen flex items-center justify-center p-6 bg-canvas focus:outline-none">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="flex justify-center">
          <CobblestoneMark size={40} />
        </div>
        <h1 className="flex items-center justify-center gap-2 text-xl font-semibold text-content">
          <WifiOff size={20} aria-hidden /> You're offline
        </h1>
        <p className="text-sm text-muted">
          Cobblr needs a connection to open this for the first time on this device. It will open by itself when you're back online; the pages you have opened
          before stay readable offline after that.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700"
        >
          Retry
        </button>
      </div>
    </main>
    </>
  );
}
