// Spreadsheets shaped like the ones people actually keep: a title over the
// header, a group header merged across columns, one brand written once down
// the side, a total at the bottom, a blank line in the middle, section
// headings instead of a location column. Built with the same library that
// reads them, written to real file bytes, so every test goes through the
// parser exactly as an upload does. `node --import tsx sheet-fixtures.ts <dir>`
// writes them out for a hand walk-through.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

type Row = Array<string | number | boolean | Date | null>;

function sheet(rows: Row[], merges: XLSX.Range[] = [], formats: Record<string, string> = {}): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!merges"] = merges;
  for (const [addr, z] of Object.entries(formats)) {
    const c = ws[addr] as XLSX.CellObject | undefined;
    if (c) c.z = z;
  }
  return ws;
}

const r = (s: { r: number; c: number }, e: { r: number; c: number }): XLSX.Range => ({ s, e });
/** A date as a spreadsheet stores it: a day number, shown by its format. */
const d = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

function bytes(wb: XLSX.WorkBook, bookType: XLSX.BookType): Uint8Array {
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType }) as Buffer);
}

/** Thirteen columns under a title, a blank line and a two-row header. */
/** `photoBase` is where the picture links point; a walk that serves real
 *  pictures passes its own server, a unit test never fetches them. */
export function printerList(bookType: "xlsx" | "xls" | "ods" = "xlsx", photoBase = process.env.PHOTO_BASE || "https://example.com/p"): { buf: Uint8Array; filename: string } {
  const rows: Row[] = [
    ["Print farm inventory (updated March 2024)"],
    [],
    [null, null, "Build volume (mm)", null, null, "Nozzle", null, null, null, null, null, null, null],
    ["Printer", "Brand", "X", "Y", "Z", "Size", "Material", "Where", "Serial #", "Bought", "Price", "Photo", "Notes"],
    ["MK4 #1", "Prusa", 250, 210, 220, "0.4 mm", "Brass", "Garage / Rack A", "CZPX1223X004XK12345", d("2023-11-02"), 1099, `${photoBase}/mk4-1.jpg`, "Daily driver, PLA only"],
    ["MK4 #2", null, 250, 210, 220, "0.6 mm", "Hardened steel", "Garage / Rack A", "CZPX1223X004XK12346", d("2023-11-02"), 1099, `${photoBase}/mk4-2.jpg`, null],
    ["Mini+", null, 180, 180, 180, "0.4 mm", "Brass", "Office", "CZPX0921X003XC00871", d("2021-09-14"), 459, null, "Needs a new PEI sheet"],
    [],
    ["X1 Carbon", "Bambu Lab", 256, 256, 256, "0.4 mm", "Hardened steel", "Garage / Rack B", "01S00C123400567", d("2024-01-20"), "$1,449.00", `${photoBase}/x1c.png`, "AMS attached, four spools"],
    ["Ender 3 V2", "Creality", 220, 220, 250, "0.4 mm", "Brass", "Basement shelf", "E3V2-88213", d("2020-12-01"), 279, null, "Retired, spare parts"],
    ["Voron 2.4", "Self-built", 350, 350, 340, "0.4 mm", "Brass", "Garage / Rack B", "VORON-2405", d("2022-06-30"), 1650, null, "Kit from LDO, 48V"],
    ["Total", null, null, null, null, null, null, null, null, null, 6035, null, null],
  ];
  const ws = sheet(
    rows,
    [r({ r: 0, c: 0 }, { r: 0, c: 12 }), r({ r: 2, c: 2 }, { r: 2, c: 4 }), r({ r: 2, c: 5 }, { r: 2, c: 6 }), r({ r: 4, c: 1 }, { r: 6, c: 1 })],
    { K5: '"$"#,##0.00', K6: '"$"#,##0.00', K7: '"$"#,##0.00', K10: '"$"#,##0.00', K11: '"$"#,##0.00', J5: "yyyy-mm-dd", J6: "yyyy-mm-dd", J7: "yyyy-mm-dd", J9: "yyyy-mm-dd", J10: "yyyy-mm-dd", J11: "yyyy-mm-dd" },
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Printers");
  return { buf: bytes(wb, bookType === "xls" ? "biff8" : bookType), filename: `printers.${bookType}` };
}

/** A CSV saved from a spreadsheet on another machine: BOM, CRLF, quoted
 *  commas, ISBNs with hyphens and one ISBN-10 ending in X. */
export function bookList(): { buf: Uint8Array; filename: string } {
  const lines = [
    "Title,Author,ISBN,Genre,Read?,Rating,Shelf",
    'Dune,Frank Herbert,978-0-441-17271-9,Science fiction,Y,5,Living room',
    '"Good Omens","Pratchett, Terry; Gaiman, Neil",978-0-06-085398-3,Fantasy,Y,4,Living room',
    "The Hobbit,J. R. R. Tolkien,0-261-10221-4,Fantasy,N,,Bedroom",
    "Neuromancer,William Gibson,978-0-441-56959-5,Science fiction,Y,4,Living room",
    "Piranesi,Susanna Clarke,978-1-63557-563-7,Fantasy,N,,Bedroom",
    "The Martian,Andy Weir,978-0-553-41802-6,Science fiction,Y,5,Office",
    "Gödel Escher Bach,Douglas Hofstadter,0-465-02656-7,Non-fiction,N,,Office",
    "Sapiens,Yuval Noah Harari,978-0-06-231609-7,Non-fiction,Y,3,Office",
  ];
  const text = `﻿${lines.join("\r\n")}\r\n`;
  return { buf: new TextEncoder().encode(text), filename: "books.csv" };
}

/** The book list saved without its header row: the file starts with Dune. */
export function bookListNoHeader(): { buf: Uint8Array; filename: string } {
  const text = new TextDecoder().decode(bookList().buf).replace(/^\uFEFF/, "");
  const withoutHeader = text.split("\r\n").slice(1).join("\r\n");
  return { buf: new TextEncoder().encode(withoutHeader), filename: "books.csv" };
}

/** The same book list a month later: one rating changed, one book finished,
 *  one new book on the end. What a person re-imports. */
export function bookListEdited(): { buf: Uint8Array; filename: string } {
  const lines = [
    "Title,Author,ISBN,Genre,Read?,Rating,Shelf",
    'Dune,Frank Herbert,978-0-441-17271-9,Science fiction,Y,4,Living room',
    '"Good Omens","Pratchett, Terry; Gaiman, Neil",978-0-06-085398-3,Fantasy,Y,4,Living room',
    "The Hobbit,J. R. R. Tolkien,0-261-10221-4,Fantasy,Y,5,Bedroom",
    "Neuromancer,William Gibson,978-0-441-56959-5,Science fiction,Y,4,Living room",
    "Piranesi,Susanna Clarke,978-1-63557-563-7,Fantasy,N,,Bedroom",
    "The Martian,Andy Weir,978-0-553-41802-6,Science fiction,Y,5,Office",
    "Gödel Escher Bach,Douglas Hofstadter,0-465-02656-7,Non-fiction,N,,Office",
    "Sapiens,Yuval Noah Harari,978-0-06-231609-7,Non-fiction,Y,3,Office",
    "Project Hail Mary,Andy Weir,978-0-593-13520-4,Science fiction,N,,Hallway",
  ];
  return { buf: new TextEncoder().encode(`\uFEFF${lines.join("\r\n")}\r\n`), filename: "books.csv" };
}

/** No location column: the place is a section heading above its rows. Best
 *  before written as text, day first, the way most of the world writes it. */
export function pantryList(): { buf: Uint8Array; filename: string } {
  const rows: Row[] = [
    ["Item", "Qty", "Best before", "Opened"],
    ["Fridge"],
    ["Milk", "2 L", "03/10/2025", "no"],
    ["Greek yoghurt", "500 g", "29/09/2025", "yes"],
    ["Butter", "250 g", "14/11/2025", "no"],
    ["Freezer"],
    ["Peas", "1 kg", "01/06/2026", "yes"],
    ["Chicken thighs", "6", "12/02/2026", "no"],
    ["Cupboard"],
    ["Rice", "5 kg", "31/12/2026", "yes"],
    ["Chickpeas", "3 cans", "15/08/2027", "no"],
    ["Olive oil", "750 ml", "20/05/2026", "yes"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(rows), "Pantry");
  return { buf: bytes(wb, "xlsx"), filename: "pantry.xlsx" };
}

/** Two lists in one file, a hidden lookup sheet and an empty third tab.
 *  `kit` names the first list "Kit" with an "Item" column, for a test that
 *  needs a list no collection is called (a "Tools" sheet is offered Hand
 *  Tools now that it exists). */
export function workshopWorkbook(bookType: "xlsx" | "ods" = "xlsx", opts: { kit?: boolean } = {}): { buf: Uint8Array; filename: string } {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet([
      [opts.kit ? "Item" : "Tool", "Make", "Category", "Location", "Qty"],
      ["Cordless drill", "Makita", "Power tools", "Pegboard", 1],
      ["Impact driver", "Makita", "Power tools", "Pegboard", 1],
      ["Hex key set", "Wera", "Hand tools", "Top drawer", 2],
      ["Calipers", "Mitutoyo", "Measuring", "Top drawer", 1],
      ["Flush cutters", "Knipex", "Hand tools", "Top drawer", 3],
      ["Multimeter", "Fluke", "Measuring", "Shelf 2", 1],
    ]),
    opts.kit ? "Kit" : "Tools",
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheet([
      ["Part", "SKU", "On hand", "Reorder at", "Supplier", "Tags"],
      ["M3x8 socket screw", "M3-8-SHCS", 180, 50, "https://example.com/m3", "fasteners, metric"],
      ["M3 heat insert", "M3-HSI", 95, 100, "https://example.com/hsi", "fasteners, inserts"],
      ["608 bearing", "BRG-608", 12, 10, "https://example.com/608", "bearings"],
      ["PTFE tube 1m", "PTFE-1M", 4, 2, "https://example.com/ptfe", "printer parts, consumables"],
      ["PLA white 1kg", "PLA-WHT", 7, 3, "https://example.com/pla", "filament, consumables"],
    ]),
    "Consumables",
  );
  XLSX.utils.book_append_sheet(wb, sheet([["Categories"], ["Power tools"], ["Hand tools"], ["Measuring"]]), "Lookups");
  XLSX.utils.book_append_sheet(wb, sheet([]), "Sheet3");
  wb.Workbook = { Sheets: [{ name: "Tools" }, { name: "Consumables" }, { name: "Lookups", Hidden: 1 }, { name: "Sheet3" }] };
  return { buf: bytes(wb, bookType), filename: `workshop.${bookType}` };
}

/** A printer collector's acquisition list, transcribed from a real one: 66
 *  printers with NO header on top, the header row (Model, Price,
 *  Fees/Shipping, Fate, Acquisition Date) BELOW them at row 67, then a block
 *  of totals. Prices written "Free" and "Free in Trade", fees on a few rows, a
 *  Fate for what left the collection, four identical printers bought the same
 *  day twice over, one date out of order and one with a two-digit year.
 *
 *  The last cell of the totals (Total Still Owned, F70) ran off the edge of
 *  the picture it was copied from; it holds what the label says, the count of
 *  rows with no Fate. */
// VOCAB-ENUMERATION OK: a transcribed spreadsheet's own cells, not a vocabulary
const ACQUISITIONS: Array<[string, number | string, number | null, string | null, string | null]> = [
  ["Makerbot Replicator+ (6th Gen)", "Free", null, "Sold for $100", "2021-10-15"],
  ["3D Systems Cube 3", "Free", null, "Parted out", "2021-10-15"],
  ["Creality Ender 3 Pro", 199, null, null, "2021-12-05"],
  ["Creality Ender 3 Pro", 99, null, "Parted out", "2021-12-09"],
  ["Creality Ender 3 Pro", 99, null, "Given to Cousin", "2021-02-07"],
  ["Prusa MK3", "Free", null, null, "2022-03-09"],
  ["Flash Forge Creator Pro", "Free", null, "Parted out", "2022-07-27"],
  ["Flash Forge Creator Pro", "Free", null, "Parted out", "2022-09-22"],
  ["Voron 2.4r2", 300, null, null, "2022-12-04"],
  ["Voron Legacy", 900, null, null, "2023-02-14"],
  ["SecKit Cube", 200, null, null, "2023-07-07"],
  ["Ultimaker Original", 100, null, null, "2023-07-22"],
  ["TwoTrees Sapphire Plus", "Free", null, "Parted out", "2023-12-22"],
  ["SV-06", "Free", null, "Given to Dad", "2023-12-22"],
  ["Makerbot Replicator", 100, null, null, "2024-02-02"],
  ["Tronxy X5SA", 60, null, "Turned into VZBot", "2024-08-17"],
  ["Lulzbot Taz 5", 100, null, null, "2024-08-22"],
  ["E3D BigBox", 100, null, null, "2024-09-22"],
  ["Creality Ender 3 S1", 70, null, "Given to Son/Now Sold", "2024-09-23"],
  ["Lulzbot Taz 4", "Free", null, null, "2024-09-27"],
  ["Creality LD-002H", 65, null, null, "2024-10-18"],
  ["MonoPrice Mini Delta", 30, null, null, "2025-02-23"],
  ["Ultimaker Original+", 200, null, null, "2025-03-14"],
  ["MakerBot Replicator", 100, null, null, "2025-03-21"],
  ["Ender 3 V2", 5, null, null, "2025-03-31"],
  ["Sunlu Terminator 3", 5, null, null, "2025-03-31"],
  ["Flash Forge Creator Pro", "Free", null, null, "2025-03-31"],
  ["2012 MakerBot Replicator", "Free in Trade", null, null, "2025-04-10"],
  ["Printerbot Simple Metal", 10, null, null, "2025-05-07"],
  ["Makergear M2 Rev H", "Free", null, null, "2025-06-02"],
  ["Solidoodle 2 Pro", "Free", null, null, "2025-06-05"],
  ["Anycubic Kobra", 25, null, "Sold at Cost to Coworker", "2025-06-06"],
  ["MakerBot Cupcake", 200, 34.25, null, "2025-06-30"],
  ["Printrbot Simple 2014", 40, null, null, "2025-07-03"],
  ["Anycubic Predator", "Free", null, null, "2025-07-10"],
  ["Printrbot Plus", 35, null, null, "2025-07-11"],
  ["Makerbot Replicator", 31, 26.05, null, "2025-07-25"],
  ["MakerBot Replicator Gen 5", "Free", null, null, "2025-08-11"],
  ["Lulzbot Taz 6", "Free", null, null, "2025-08-11"],
  ["Makerbot Cupcake MK5", 150, 73.8, null, "2025-08-25"],
  ["MakerBot Thing-O-Matic", 50, 50, null, "2025-09-04"],
  ["Makergear M2 Rev A", 50, null, null, "2025-09-18"],
  ["MakerBot Thing-O-Matic", "Free", null, null, "2025-09-28"],
  ["Ultimaker Original+", 25, 95, null, "2025-09-30"],
  ["MakerBot Thing-O-Matic", "Free", null, null, "2025-11-07"],
  ["Makergear M2", 25, null, null, "2025-11-21"],
  ["MakerBot Thing-O-Matic", "Free", 80.99, null, "2025-12-23"],
  ["RatRig V-Core 3.1 200mm", 200, null, null, "2026-01-19"],
  ["Makergear Mosaic M1", 300, 105.46, null, "2026-01-14"],
  ["Voron Trident 350mm", 350, null, null, "2026-01-30"],
  ["2013 Printrbot Simple", "Free", null, null, "2026-02-20"],
  ["2011 MakerBot Thing-O-Matic", 75, null, null, "2026-03-05"],
  ["Tronxy X5S", 37.5, null, null, "2026-03-10"],
  ["Prusa MK3S with MMU2S", 37.5, null, null, "2026-03-10"],
  ["Artillery Sidewinder X1", 10, null, null, "2026-03-19"],
  ["Artillery Sidewinder X1", 10, null, null, "2026-03-19"],
  ["Artillery Sidewinder X1", 10, null, null, "2026-03-19"],
  ["Artillery Sidewinder X1", 10, null, null, "2026-03-19"],
  ["Creality CR-10 S5", 10, null, null, "2026-03-19"],
  ["Lulzbot Taz 6", 10, null, null, "2026-03-19"],
  ["Lulzbot Taz 6", 10, null, null, "2026-03-19"],
  ["Lulzbot Taz 6", 10, null, null, "2026-03-19"],
  ["Lulzbot Taz 6", 10, null, null, "2026-03-19"],
  ["Lulzbot Workhorse+", 10, null, null, "2026-03-19"],
  ["Mendel90", "Free", null, null, null],
  ["Prusa Core One", 400, null, null, null],
];

export const ACQUISITION_FACTS = {
  rows: ACQUISITIONS.length,
  priceTotal: 4873,
  feeTotal: 465.55,
  costTotal: 5338.55,
  averageCost: 83.41,
  stillOwned: ACQUISITIONS.filter((a) => !a[3]).length,
  partedOut: ACQUISITIONS.filter((a) => a[3] === "Parted out").length,
};

export function printerAcquisitions(format: "xlsx" | "csv" = "xlsx"): { buf: Uint8Array; filename: string } {
  const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // As a spreadsheet shows a date typed as 12/5/2021; row 40 was typed 8/25/25.
  const shown = (iso: string, i: number) => {
    const [y, m, dd] = iso.split("-").map(Number) as [number, number, number];
    return `${m}/${dd}/${i === 39 ? String(y).slice(2) : y}`;
  };
  const header = ["Model", "Price", "Fees/Shipping", "Fate", "Acquisition Date"];
  const totals: Row[] = [
    ["Price Totals", ACQUISITION_FACTS.priceTotal],
    ["Fee/Shipping Totals", ACQUISITION_FACTS.feeTotal],
    ["Acquisiton Cost Total", ACQUISITION_FACTS.costTotal, "Average Cost", ACQUISITION_FACTS.averageCost, "Total Still Owned", ACQUISITION_FACTS.stillOwned],
  ];
  if (format === "csv") {
    const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ACQUISITIONS.map(([model, price, fee, fate, date], i) =>
      [model, typeof price === "number" ? money(price) : price, fee == null ? "" : money(fee), fate ?? "", date ? shown(date, i) : ""].map(q).join(","),
    );
    lines.push(header.join(","));
    for (const t of totals) lines.push(t.map((v, i) => q(typeof v === "number" ? (i === 5 ? String(v) : money(v)) : String(v ?? ""))).join(","));
    return { buf: new TextEncoder().encode(`${lines.join("\r\n")}\r\n`), filename: "3D Printer Acquisitions.csv" };
  }
  const rows: Row[] = ACQUISITIONS.map(([model, price, fee, fate, date]) => [model, price, fee, fate, date ? d(date) : null]);
  rows.push(header, ...totals);
  const formats: Record<string, string> = {};
  rows.forEach((row, i) => {
    const n = i + 1;
    if (i < ACQUISITIONS.length) {
      if (typeof row[1] === "number") formats[`B${n}`] = '"$"#,##0.00';
      if (typeof row[2] === "number") formats[`C${n}`] = '"$"#,##0.00';
      if (row[4] != null) formats[`E${n}`] = i === 39 ? "m/d/yy" : "m/d/yyyy";
    }
  });
  const last = ACQUISITIONS.length;
  Object.assign(formats, { [`B${last + 2}`]: '"$"#,##0.00', [`B${last + 3}`]: '"$"#,##0.00', [`B${last + 4}`]: '"$"#,##0.00', [`D${last + 4}`]: '"$"#,##0.00' });
  const ws = sheet(rows, [], formats);
  // The totals are formulas, as they are in the real sheet.
  const f = (addr: string, formula: string) => {
    const c = ws[addr] as XLSX.CellObject | undefined;
    if (c) c.f = formula;
  };
  f(`B${last + 2}`, `SUM(B1:B${last})`);
  f(`B${last + 3}`, `SUM(C1:C${last})`);
  f(`B${last + 4}`, `B${last + 2}+B${last + 3}`);
  f(`D${last + 4}`, `B${last + 4}/COUNT(E1:E${last})`);
  f(`F${last + 4}`, `COUNTBLANK(D1:D${last})`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Printers");
  return { buf: bytes(wb, "xlsx"), filename: "3D Printer Acquisitions.xlsx" };
}

if (process.argv[1]?.endsWith("sheet-fixtures.ts") && process.argv[2]) {
  for (const f of [printerList(), printerList("ods"), bookList(), pantryList(), workshopWorkbook(), printerAcquisitions(), printerAcquisitions("csv")]) {
    writeFileSync(join(process.argv[2], f.filename), f.buf);
    console.log(`wrote ${f.filename}`);
  }
}
