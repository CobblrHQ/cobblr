// A link to a section ("/configuration/ai#who-answers") lands ON the section
// (#5403). A router navigation never scrolls to a hash, and a full-page load
// only does when the element is there at load, which a page drawn from
// queries never is. So: on every location with a hash, wait for that element
// to appear (up to a few seconds) and scroll it into view, once.
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const WAIT_MS = 5000;

export function useScrollToHash() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    if (!id) return;
    const land = () => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({ block: "start" });
      return true;
    };
    if (land()) return;
    const watch = new MutationObserver(() => {
      if (land()) stop();
    });
    const giveUp = window.setTimeout(() => stop(), WAIT_MS);
    function stop() {
      watch.disconnect();
      window.clearTimeout(giveUp);
    }
    watch.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, [pathname, hash]);
}
