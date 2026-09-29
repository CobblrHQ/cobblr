// A stock agency's watermarked preview is never a picture Cobblr uses (#3804).
//
// One rule for every door a picture comes in by: the scan's picture search
// and download gate, the barcode network, and a spreadsheet's image column.
// It lived in core-scan until a second door needed it; two copies of a list
// of agencies would drift, so the list and the questions live here.
//
// An agency's preview is watermarked by design, and it is often what an image
// search returns first for a plain noun ("Classic Baguette"), because those
// pages are built to rank for exactly that. The agencies are data: adding one
// is a line below.

/** Hosts (and their subdomains) that serve an agency's pages or previews. A
 *  picture whose address, or whose page, is on one of these is refused. */
export const STOCK_AGENCY_HOSTS: readonly string[] = [
  "alamy.com",
  "alamyimages.fr",
  "alamy.de",
  "alamy.es",
  "alamy.it",
  "shutterstock.com",
  "gettyimages.com",
  "gettyimages.co.uk",
  "gettyimages.ca",
  "gettyimages.com.au",
  "gettyimages.de",
  "gettyimages.fr",
  "istockphoto.com",
  "dreamstime.com",
  "depositphotos.com",
  "123rf.com",
  "stock.adobe.com",
  "ftcdn.net", // Adobe Stock's picture host
  "bigstockphoto.com",
  "canstockphoto.com",
  "fotosearch.com",
  "agefotostock.com",
  "stockfood.com",
  "pond5.com",
  "colourbox.com",
  "superstock.com",
  "masterfile.com",
  "vectorstock.com",
  "stocksy.com",
  "featurepics.com",
  "photos.com",
  "fotolia.com",
  "panthermedia.net",
  "imagesbazaar.com",
  "pixta.jp",
  "age-fotostock.com",
  "stockunlimited.com",
  "crushpixel.com",
  "megapixl.com",
  "istock.com",
];

/** Words a result's title carries when the page is an agency's listing, even
 *  where the picture sits on a host not listed above (a reseller, a mirror).
 *  Matched as whole phrases, case-insensitive. */
export const STOCK_TITLE_PHRASES: readonly string[] = [
  "stock photo",
  "stock photos",
  "stock image",
  "stock images",
  "stock photograph",
  "stock photography",
  "stock picture",
  "stock pictures",
  "stock illustration",
  "stock vector",
  "royalty-free",
  "royalty free",
  "alamy",
  "shutterstock",
  "getty images",
  "istock",
  "dreamstime",
  "depositphotos",
  "123rf",
  "adobe stock",
];

/** Pieces of a picture's file name that only an agency's preview carries, so a
 *  preview copied to another host is still known. */
export const STOCK_PREVIEW_FILENAME_MARKERS: readonly string[] = [
  "depositphotos_",
  "stock-photo-",
  "-260nw-",
  "-600w-",
  "picture-id",
  "istockphoto-",
  "dreamstime_",
  "123rf",
  "bigstock-",
  "canstock",
];

function onAgencyHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return STOCK_AGENCY_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    // A result's `source` is a bare host.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim()) ? value.trim() : null;
  }
}

/** The picture at this address is an agency's preview: its host is an
 *  agency's, or its file name carries a marker only a preview has. */
export function isStockPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return false;
  }
  if (onAgencyHost(u.hostname)) return true;
  const file = decodeURIComponent(u.pathname.split("/").pop() ?? "").toLowerCase();
  return STOCK_PREVIEW_FILENAME_MARKERS.some((m) => file.includes(m));
}

const TITLE_RE = new RegExp(
  `(^|[^a-z0-9])(${STOCK_TITLE_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})([^a-z0-9]|$)`,
  "i",
);

/** A search result that is an agency's preview: the picture's address, the
 *  page it was found on, or the page's own title says so. */
export function isStockPreviewResult(r: { url?: string | null; source?: string | null; title?: string | null }): boolean {
  if (isStockPreviewUrl(r.url)) return true;
  const page = r.source ? hostOf(r.source) : null;
  if (page && onAgencyHost(page)) return true;
  return !!r.title && TITLE_RE.test(r.title);
}
