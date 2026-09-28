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
export function printerList(bookType: "xlsx" | "xls" | "ods" = "xlsx"): { buf: Uint8Array; filename: string } {
  const rows: Row[] = [
    ["Print farm inventory (updated March 2024)"],
    [],
    [null, null, "Build volume (mm)", null, null, "Nozzle", null, null, null, null, null, null, null],
    ["Printer", "Brand", "X", "Y", "Z", "Size", "Material", "Where", "Serial #", "Bought", "Price", "Photo", "Notes"],
    ["MK4 #1", "Prusa", 250, 210, 220, "0.4 mm", "Brass", "Garage / Rack A", "CZPX1223X004XK12345", d("2023-11-02"), 1099, "https://example.com/p/mk4-1.jpg", "Daily driver, PLA only"],
    ["MK4 #2", null, 250, 210, 220, "0.6 mm", "Hardened steel", "Garage / Rack A", "CZPX1223X004XK12346", d("2023-11-02"), 1099, "https://example.com/p/mk4-2.jpg", null],
    ["Mini+", null, 180, 180, 180, "0.4 mm", "Brass", "Office", "CZPX0921X003XC00871", d("2021-09-14"), 459, null, "Needs a new PEI sheet"],
    [],
    ["X1 Carbon", "Bambu Lab", 256, 256, 256, "0.4 mm", "Hardened steel", "Garage / Rack B", "01S00C123400567", d("2024-01-20"), "$1,449.00", "https://example.com/p/x1c.png", "AMS attached, four spools"],
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

/** Two lists in one file, a hidden lookup sheet and an empty third tab. */
export function workshopWorkbook(bookType: "xlsx" | "ods" = "xlsx"): { buf: Uint8Array; filename: string } {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheet([
      ["Tool", "Make", "Category", "Location", "Qty"],
      ["Cordless drill", "Makita", "Power tools", "Pegboard", 1],
      ["Impact driver", "Makita", "Power tools", "Pegboard", 1],
      ["Hex key set", "Wera", "Hand tools", "Top drawer", 2],
      ["Calipers", "Mitutoyo", "Measuring", "Top drawer", 1],
      ["Flush cutters", "Knipex", "Hand tools", "Top drawer", 3],
      ["Multimeter", "Fluke", "Measuring", "Shelf 2", 1],
    ]),
    "Tools",
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

if (process.argv[1]?.endsWith("sheet-fixtures.ts") && process.argv[2]) {
  for (const f of [printerList(), printerList("ods"), bookList(), pantryList(), workshopWorkbook()]) {
    writeFileSync(join(process.argv[2], f.filename), f.buf);
    console.log(`wrote ${f.filename}`);
  }
}
