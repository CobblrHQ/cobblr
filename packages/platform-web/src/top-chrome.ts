// Persistent top banners reserve space for both fixed headers and page flow.
const banners = new Set<HTMLElement>();
let previousPadding = "";
let previousHeight = 0;

export function layoutTopChromeNow() {
  let height = 0;
  for (const banner of banners) {
    banner.style.setProperty("--fc-top", `${height}px`);
    height += banner.getBoundingClientRect().height;
  }
  if (banners.size) {
    document.documentElement.style.setProperty("--top-chrome-height", `${height}px`);
    document.body.style.paddingTop = previousPadding ? `calc(${previousPadding} + ${height}px)` : `${height}px`;
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
    layoutTopChromeNow();
  };
}
