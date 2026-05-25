// A floating button that scrolls the page back to the top, shown
// once the user has scrolled past a threshold (default 400px). Lives
// in platform-web because every long-list page in the app benefits
// from it — catalog entries, activity log, inbox, etc.

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

interface Props {
  /** Pixel scroll-Y at which the button appears. */
  threshold?: number;
  /** Scrollable element to watch + scroll. Defaults to window. */
  target?: HTMLElement | null;
}

export function BackToTop({ threshold = 400, target }: Props = {}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = target ?? window;
    const getY = () =>
      target instanceof HTMLElement ? target.scrollTop : window.scrollY;
    const onScroll = () => setVisible(getY() > threshold);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [threshold, target]);

  function scrollTop() {
    if (target instanceof HTMLElement) {
      target.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={scrollTop}
      aria-label="Back to top"
      title="Back to top"
      className="fixed bottom-6 right-6 z-40 w-11 h-11 rounded-full bg-cobble-600 hover:bg-cobble-700 text-white shadow-lg flex items-center justify-center transition opacity-90 hover:opacity-100"
    >
      <ArrowUp size={18} />
    </button>
  );
}
