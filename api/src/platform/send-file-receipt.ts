import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@cobblr/platform-contract/service-consent";
import { SendReceiptSchema, type SendFile, type SendReceipt } from "@cobblr/platform-contract/send-file";

export function sendFileDigest(file: SendFile): string {
  const {confirmation_key, ...body} = file;
  void confirmation_key;
  return createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(body)))).digest("hex");
}

function signature(receipt: Omit<SendReceipt, "signature">, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(receipt)).digest("hex");
}

export function signSendReceipt(receipt: Omit<SendReceipt, "signature">, key: string): SendReceipt {
  const body = SendReceiptSchema.omit({signature: true}).parse(receipt);
  return {...body, signature: signature(body, key)};
}

export interface ExpectedSendReceipt {
  file_id: string; digest: string; source_instance: string; source_org: string; ids: string[]; phase: "imported" | "undone";
  target?: {instance: string; org: string; import_id: string};
}

export function verifySendReceipt(input: unknown, key: string, expected: ExpectedSendReceipt): boolean {
  const parsed = SendReceiptSchema.safeParse(input);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(key)) return false;
  const r = parsed.data;
  if (r.file_id !== expected.file_id || r.digest !== expected.digest || r.source_instance !== expected.source_instance || r.source_org !== expected.source_org || r.phase !== expected.phase) return false;
  if (r.ids.length !== expected.ids.length || new Set(r.ids).size !== r.ids.length || r.ids.some((id) => !expected.ids.includes(id))) return false;
  if (expected.target && (r.import_id !== expected.target.import_id || r.target.instance !== expected.target.instance || r.target.org !== expected.target.org)) return false;
  const {signature: sent, ...body} = r;
  return timingSafeEqual(Buffer.from(sent, "hex"), Buffer.from(signature(body, key), "hex"));
}
