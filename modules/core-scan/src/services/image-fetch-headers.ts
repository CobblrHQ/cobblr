// Browser-like headers for fetching an EXTERNAL image URL server-side. Hotlink
// protection keys on a real User-Agent + a same-origin Referer + an image Accept;
// a bot UA with no Referer is why an image a user can view full-screen in their
// browser 403s when WE fetch it to store it (reported 2026-07-24). Pure leaf module
// (no imports) so any fetcher can use it without an import cycle.
export function browserImageHeaders(imageUrl: string): Record<string, string> {
  let referer = "https://www.google.com/";
  try {
    referer = `${new URL(imageUrl).origin}/`;
  } catch {
    /* keep the default */
  }
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer,
  };
}
