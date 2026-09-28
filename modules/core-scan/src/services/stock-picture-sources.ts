// Stock agencies whose web pictures are watermarked previews (#3804).
//
// Data, not logic: stock-preview.ts reads these lists, and adding an agency is
// a line here. An agency's preview is watermarked by design, and it is often
// what an image search returns first for a plain noun ("Classic Baguette"),
// because those pages are built to rank for exactly that. A preview is never
// an item's picture, and never a catalog picture shared with the network.

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
