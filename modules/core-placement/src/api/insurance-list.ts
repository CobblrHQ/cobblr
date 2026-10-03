import { centsFromAmount, formatMoneyPlain, formatStoredMoney, moneyTotalNote } from "@cobblr/platform-contract/money";
import { countOf } from "@cobblr/platform-contract/plural";
import { platform, type EntityRef, type PlacementWorth, type ResolvedEntity, type ValueViewer } from "@cobblr/platform-contract";
import { toCsv } from "@cobblr/platform-contract/csv";
import { PDFDocument, StandardFonts } from "pdf-lib";

export interface InsuranceRow {
  photo: string;
  name: string;
  serial: string;
  paid: number | null;
  currency?: string;
  date: string;
  path: string;
  ref: EntityRef;
}

const text = (v: unknown): string => v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v : "";

export function insuranceRows(worth: PlacementWorth, entities: ResolvedEntity[], paths: Map<string, Array<EntityRef & { name: string }>>): InsuranceRow[] {
  const found = new Map(entities.map((e) => [`${e.kind}:${e.id}`, e]));
  return worth.items.map((r) => {
    const e = found.get(`${r.kind}:${r.id}`);
    if (!e) throw new Error("A record could not be read. Try exporting again.");
    const f = e.fields as Record<string, unknown>;
    return {
      currency: worth.currency, ref: r, photo: text(e.image_path ?? f.image_path), name: e.title,
      serial: text(r.serial ?? f.serial_number ?? f.serial ?? f.vin), paid: r.value,
      date: text(r.date ?? f.purchased_at ?? f.purchase_date).slice(0, 10),
      path: [...(paths.get(`${r.kind}:${r.id}`) ?? [])].reverse().map((s) => s.name).join(" / "),
    };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

export function insuranceCsv(rows: InsuranceRow[]): string {
  return toCsv(["Photo", "Name", "Serial", "Paid", "Date", "Place path"], rows.map((r) => [r.photo, r.name, r.serial, r.paid == null ? null : (r.currency ? `${r.paid} ${r.currency}` : formatMoneyPlain(centsFromAmount(r.paid))), r.date, r.path]));
}

export async function readInsuranceList(orgId: string, within: EntityRef, viewer: ValueViewer): Promise<{ worth: PlacementWorth; rows: InsuranceRow[]; title: string }> {
  const [worth, place] = await Promise.all([
    platform().placement.worth({ orgId, within, viewer, insurance: true }),
    platform().entities.lookup(orgId, within.kind, within.id, viewer),
  ]);
  if (!place) throw new Error("placement: That place could not be found.");
  if (worth.withheld) throw new Error("Some costs are hidden from you, so an insurance list cannot be made.");
  const [entities, paths] = await Promise.all([
    platform().entities.lookupMany(orgId, worth.items, viewer),
    platform().placement.pathsOf({ orgId, containees: worth.items }),
  ]);
  return { worth, rows: insuranceRows(worth, entities, paths), title: place.title };
}

export async function insurancePdf(orgId: string, title: string, worth: PlacementWorth, rows: InsuranceRow[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Preserve characters outside the PDF's built-in font as their Unicode
  // escapes, rather than dropping a name or refusing the whole document.
  const printable = (s: string) => [...s].map((c) => { try { font.encodeText(c); return c; } catch { return `\\u{${c.codePointAt(0)!.toString(16)}}`; } }).join("");
  let page = doc.addPage();
  let y = page.getHeight() - 40;
  const line = (s: string, size = 10) => {
    const words = printable(s).split(/\s+/);
    let current = "";
    const draw = () => {
      if (y < 40) { page = doc.addPage(); y = page.getHeight() - 40; }
      page.drawText(current, { x: 40, y, font, size }); y -= size + 6;
    };
    for (const word of words) {
      for (const c of (current ? " " : "") + word) {
        if (font.widthOfTextAtSize(current + c, size) > page.getWidth() - 80) { draw(); current = ""; }
        current += c;
      }
    }
    if (current) draw();
  };
  line(`Insurance list: ${title}`, 16);
  line(`Contents worth: ${formatStoredMoney(worth.total, "amount", { currency: worth.currency })} (${countOf(worth.records, "thing")}). ${worth.unpriced} with no price.`);
  const rates = moneyTotalNote({ excluded: worth.excluded || {}, conversions: worth.conversions || [] });
  if (rates) line(rates);
  for (const row of rows) {
    if (y < 170) { page = doc.addPage(); y = page.getHeight() - 40; }
    line(row.name, 12);
    line(`Serial: ${row.serial || "Not recorded"} | Paid: ${row.paid == null ? "No price" : formatStoredMoney(row.paid, "amount", { currency: row.currency })} | Date: ${row.date || "Not recorded"}`);
    line(`Place: ${row.path}`);
    const attachments = await platform().files.listAttachments(orgId, { source_module: row.ref.kind.split(":")[0]!, source_type: row.ref.kind.split(":").slice(1).join(":"), source_id: row.ref.id });
    const coverId = /(?:^|\/)files\/([0-9a-f-]{36})\/raw(?:[?]|$)/i.exec(row.photo)?.[1];
    const photo = attachments?.find((f) => f.kind === "image");
    const fileId = coverId ?? photo?.fileId;
    const bytes = fileId ? (await platform().files.read(orgId, fileId, "thumb")) ?? (await platform().files.read(orgId, fileId, "original")) : null;
    if (bytes) {
      try {
        const image = bytes.mimeType === "image/png" ? await doc.embedPng(bytes.bytes) : await doc.embedJpg(bytes.bytes);
        const dims = image.scaleToFit(80, 60);
        page.drawImage(image, { x: 40, y: y - dims.height, width: dims.width, height: dims.height }); y -= dims.height + 10;
      } catch { line(`Photo: ${row.photo || "Could not embed photo"}`); }
    } else line(`Photo: ${row.photo || "Not recorded"}`);
    y -= 12;
  }
  return doc.save();
}
