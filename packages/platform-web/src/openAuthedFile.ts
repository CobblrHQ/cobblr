// Open a Bearer-authed file in a new tab: the one door for "open this file"
// from anywhere in the UI, a module's included.
//
// A plain <a href=".../raw"> carries no Authorization header, and auth is
// Bearer-only, so it 401s: a Design's pattern PDF never opened (#3753). So
// the file is fetched with the token and the tab is handed a blob: URL.
//
// Two details decide whether "open" opens on a phone:
//  - The tab is opened synchronously, inside the click, and pointed at the
//    blob once it arrives. A window.open after an await is a popup Safari
//    blocks.
//  - The server serves every non-image original as octet-stream (so an
//    uploaded HTML file can never run same-origin), and an octet-stream blob
//    downloads instead of displaying. A PDF is re-typed so the browser's own
//    viewer shows it. Only a PDF: a blob: URL shares the app's origin, and a
//    re-typed HTML or SVG would run as us.

const TOKEN_KEY = "cobblr.token";
const VIEWABLE = new Set(["application/pdf"]);

export interface OpenAuthedFileOptions {
  /** The token to send; defaults to the SPA's stored session token. */
  getToken?: () => string | null | undefined;
  /** The file's stored type, when the caller has it (an attachment row's
   *  `mime_type`). A PDF is opened in the viewer rather than downloaded. */
  mime?: string | null;
  /** Used to recognise a PDF when no type is known. */
  filename?: string | null;
}

function viewableType(opts: OpenAuthedFileOptions): string | null {
  const mime = (opts.mime ?? "").toLowerCase();
  if (VIEWABLE.has(mime)) return mime;
  if (/\.pdf$/i.test(opts.filename ?? "")) return "application/pdf";
  return null;
}

/** Call from the click handler itself (not after an await), or the new tab
 *  is a blocked popup. Resolves true when the file was handed to a tab. */
export async function openAuthedFile(url: string, opts: OpenAuthedFileOptions = {}): Promise<boolean> {
  const tab = typeof window !== "undefined" ? window.open("", "_blank") : null;
  if (tab) tab.opener = null;
  const token = opts.getToken ? opts.getToken() : typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
  let res: Response;
  try {
    res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    tab?.close();
    return false;
  }
  if (!res.ok) {
    tab?.close();
    return false;
  }
  const raw = await res.blob();
  const type = viewableType(opts);
  const blob = type ? new Blob([raw], { type }) : raw;
  const objectUrl = URL.createObjectURL(blob);
  if (tab) {
    tab.location.href = objectUrl;
  } else {
    // No tab (a blocker won anyway): hand the file over as a download.
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = opts.filename || "download";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return true;
}
