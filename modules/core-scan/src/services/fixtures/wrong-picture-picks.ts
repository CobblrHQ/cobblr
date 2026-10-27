// Pictures the web handed back for a record that did not show it, beside one
// that did. Each wrong one is shaped the way the search returned it: a title,
// an address, the page's host and, when the engine said, the size. Add a row
// whenever a wrong picture reaches a record.
import type { DdgImageResult } from "../ddg-images.js";

export interface PicturePick {
  record: { name: string; brand: string | null };
  /** What it got, and why that is wrong. */
  wrong: Array<DdgImageResult & { why: string }>;
  /** A picture that does show it; null when nothing in the pool should win. */
  right: DdgImageResult | null;
}

const shot = (title: string, url: string, width = 1000, height = 1000): DdgImageResult => ({
  title,
  url,
  thumb: `https://thumbs.example-search.com/i/${encodeURIComponent(url)}`,
  source: new URL(url).hostname,
  width,
  height,
});

export const WRONG_PICTURE_PICKS: PicturePick[] = [
  {
    // Three printers named after their maker, a sheet-metal shop, each got
    // the shop's marketing banner (2026-09-30).
    record: { name: "Custom Sheet Metal Printer Black", brand: "Custom Sheet Metal" },
    wrong: [
      { ...shot("Custom Sheet Metal Fabrication | Enclosures & Cabinets", "https://www.customsheetmetal.example/img/hero-banner.jpg", 1920, 640), why: "a wide marketing banner" },
      { ...shot("Custom Sheet Metal Enclosures, Welded Cabinets", "https://www.customsheetmetal.example/img/cabinet.jpg", 1200, 900), why: "only the maker's words, no printer" },
      { ...shot("Custom sheet metal parts manufacturing", "https://parts.example-shop.com/sheet-metal.jpg", 900, 900), why: "says it is manufacturing" },
      // Seen live (2026-10-01): its title says printer, and it is a picture
      // nobody photographed.
      { ...shot("A red printer with the word lg on the bottom | Premium AI-generated image", "https://stock.example-art.com/red-printer.jpg", 1000, 1000), why: "an AI-generated image" },
    ],
    right: shot("Custom Sheet Metal enclosed 3D printer, black", "https://www.customsheetmetal.example/img/printer-black.jpg"),
  },
  {
    // A new printer was given a Prusa XL straight from its create (#8651):
    // the create path judged its search phrase, so "printer" was enough. The
    // rest came back for the same search, seen live (2026-10-27).
    record: { name: "Prusa MK4 3D printer", brand: null },
    wrong: [
      { ...shot("Original Prusa XL 3D printer", "https://www.prusa3d.example/content/images/product/original-prusa-xl.jpg"), why: "another of the maker's printers" },
      { ...shot("Prusa 3D Printer Models Compared: i3 MK4 vs SL1S", "https://3dprintingbasics.example/images/65297.webp"), why: "a comparison of several" },
      { ...shot("3D Printer Hotend Kit for Prusa MK4/XL Hot End Kit Assembly Print Head", "https://ae-pic.example-shop.com/kf/hotend-kit.jpg"), why: "a part made for it" },
    ],
    right: shot("Original Prusa MK4 3D Printer: Buy or Lease at Top3DShop", "https://top3dshop.example/image/catalog/products/original_prusa_mk4_3d_printer_image8.jpg"),
  },
  {
    record: { name: "Prusa MK4", brand: "Prusa" },
    wrong: [
      { ...shot("Original Prusa XL 3D printer", "https://www.prusa3d.example/content/images/product/original-prusa-xl.jpg"), why: "another of the maker's printers" },
      { ...shot("Prusa 3D Printer Models Compared: i3 MK4 vs SL1S", "https://3dprintingbasics.example/images/65297.webp"), why: "a comparison of several" },
      { ...shot("3D Printer Hotend Kit for Prusa MK4/XL Hot End Kit Assembly Print Head", "https://ae-pic.example-shop.com/kf/hotend-kit.jpg"), why: "a part made for it" },
    ],
    right: shot("Original Prusa MK4 3D Printer: Buy or Lease at Top3DShop", "https://top3dshop.example/image/catalog/products/original_prusa_mk4_3d_printer_image8.jpg"),
  },
  {
    record: { name: "Dremel 3D20", brand: "Dremel" },
    wrong: [{ ...shot("Dremel 3000 rotary tool kit", "https://tools.example-shop.com/dremel-3000.jpg"), why: "another of the maker's products" }],
    right: shot("Dremel Digilab 3D20 3D Printer", "https://tools.example-shop.com/dremel-3d20.jpg"),
  },
  {
    record: { name: "PLA Filament Spool Red", brand: "Hatchbox" },
    wrong: [
      { ...shot("Hatchbox logo", "https://brand.example-cdn.com/hatchbox-logo.png", 600, 600), why: "the maker's logo" },
      { ...shot("Hatchbox 3D printing filament infographic", "https://blog.example-maker.com/filament-chart.png", 800, 1100), why: "an infographic" },
    ],
    right: shot("Hatchbox PLA 1.75mm filament spool, red", "https://shop.example-maker.com/pla-red.jpg"),
  },
  {
    record: { name: "Cordless Drill", brand: "Makita" },
    wrong: [{ ...shot("Makita headquarters in Anjo", "https://news.example-press.com/makita-hq.jpg", 1200, 800), why: "the maker's building" }],
    right: shot("Makita 18V LXT cordless drill driver", "https://tools.example-shop.com/makita-drill.jpg"),
  },
  {
    // The right picture spells it the other way; that is still the thing.
    record: { name: "Blended Scotch Whiskey", brand: "Kirkland Signature" },
    wrong: [{ ...shot("Kirkland Signature store front", "https://news.example-press.com/store.jpg", 1200, 800), why: "a shop, not the bottle" }],
    right: shot("Kirkland Signature Blended Scotch Whisky 1.75L", "https://shop.example-grocer.com/scotch.jpg", 600, 1000),
  },
  {
    // The name says only who made it: nothing can be checked, so nothing wins.
    record: { name: "Bose", brand: "Bose" },
    wrong: [{ ...shot("Bose QuietComfort headphones", "https://shop.example-audio.com/qc.jpg"), why: "a guess at which Bose" }],
    right: null,
  },
];
