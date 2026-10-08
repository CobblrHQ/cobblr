import { parseDecodeRole } from "@cobblr/platform-contract/decode-role";

export interface BarcodeFillField {
  name: string;
  display_label?: string;
  decode_role?: string | null;
  field_role?: string | null;
  server_managed?: boolean | null;
}
export type { BarcodeLookup } from "@cobblr/platform-contract/barcode-form";

const BARCODE_IDENTIFIERS = new Set(["barcode", "upc", "ean", "gtin", "isbn"]);
export function barcodeField(fields: BarcodeFillField[]): BarcodeFillField | undefined {
  const available = fields.filter((f) => !f.server_managed);
  return available.find((f) => {
    const role = parseDecodeRole(f.decode_role);
    return role?.kind === "identifier" && BARCODE_IDENTIFIERS.has(role.decoderId);
  }) ?? available.find((f) => !parseDecodeRole(f.decode_role) && f.field_role === "identifier");
}
export function barcodeFills(fields: BarcodeFillField[], values: Record<string, unknown>, code: string, answer: Record<string, unknown> | null): Record<string, unknown> {
  const fills: Record<string, unknown> = {};
  const holder = barcodeField(fields);
  for (const f of fields) {
    if (f.server_managed || (values[f.name] != null && values[f.name] !== "")) continue;
    const role = parseDecodeRole(f.decode_role);
    const value = f === holder ? code : role?.kind === "target" ? answer?.[role.key] : f.field_role === "category" ? answer?.category : undefined;
    if (value != null && value !== "") fills[f.name] = value;
  }
  return fills;
}
