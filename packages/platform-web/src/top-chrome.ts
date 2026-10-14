// Persistent top banners reserve space for both fixed headers and page flow.
// They stack from below the screen's top inset (the status bar and the
// Dynamic Island of a home-screen app): drawn from y = 0, the update notice
// sat under the clock with Refresh half covered (#6550). The first one paints
// the inset in its own colour (data-fc-edge, floating-chrome.css), and
// --top-chrome-height counts the inset, so what starts below the bars
// (--safe-top) has no inset left to pay.
const INSET = "var(--inset-top, 0px)";
const banners = new Set<HTMLElement>();
let previousPadding = "";
let previousHeight = 0;

export function layoutTopChromeNow() {
  let height = 0;
  for (const banner of banners) {
    banner.style.setProperty("--fc-top", `calc(${INSET} + ${height}px)`);
    if (height === 0) banner.setAttribute("data-fc-edge", "");
    else banner.removeAttribute("data-fc-edge");
    height += banner.getBoundingClientRect().height;
  }
  if (banners.size) {
    document.documentElement.style.setProperty("--top-chrome-height", `calc(${INSET} + ${height}px)`);
    document.body.style.paddingTop = previousPadding ? `calc(${previousPadding} + ${INSET} + ${height}px)` : `calc(${INSET} + ${height}px)`;
  } else {
    document.documentElement.style.removeProperty("--top-chrome-height");
    document.body.style.paddingTop = previousPadding;
  }
  if (height !== previousHeight) {
    previousHeight = height;
    window.dispatchEvent(new Event("cobblr:top-chrome-change"));
  }
}

export function registerTopChrome(banner: HTMLElement) {
  if (!banners.size) previousPadding = document.body.style.paddingTop;
  banners.add(banner);
  const observer = new ResizeObserver(layoutTopChromeNow);
  observer.observe(banner);
  layoutTopChromeNow();
  return () => {
    observer.disconnect();
    banners.delete(banner);
    banner.style.removeProperty("--fc-top");
    banner.removeAttribute("data-fc-edge");
    layoutTopChromeNow();
  };
}
