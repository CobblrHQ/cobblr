export type DocumentPrivacy = "personal" | "normal";
export type PersonalDocumentField = "vin" | "plate" | "expires" | "amount" | "reference" | "make" | "model" | "year";
export interface PersonalDocumentRead {
  privacy: DocumentPrivacy;
  kind: "registration" | "personal" | "ordinary";
  fields: Partial<Record<PersonalDocumentField, string>>;
  /** Who read each field: code, a local model, or the cloud connection the
   *  workspace's owner consented to (#5621). */
  sources: Partial<Record<PersonalDocumentField, "code" | "local-ai" | "cloud-ai">>;
  missing: PersonalDocumentField[];
  message: string;
}
export interface DocumentInput {
  bytes: Uint8Array;
  mime: string;
  /** The upload door's temporary file, never a caller-supplied path. */
  path?: string;
  vault?: boolean;
  assist?: { orgId: string; userId?: string | null };
}
export type PersonalDocumentReader = (input: DocumentInput) => Promise<PersonalDocumentRead>;
let reader: PersonalDocumentReader | null = null;
export function registerPersonalDocumentReader(value: PersonalDocumentReader): void { reader = value; }
export async function readPersonalDocument(input: DocumentInput): Promise<PersonalDocumentRead> {
  if (reader) return reader(input);
  return { privacy: "personal", kind: "personal", fields: {}, sources: {}, missing: ["vin", "plate", "expires", "amount", "reference"],
    message: "This document could not be read here. It has not been sent to a cloud AI." };
}
export type PersonalDocumentStorage = (request: { orgId: string; userId: string; input: DocumentInput; filename: string; folderId?: string }) => Promise<{ fileId: string; folderId: string }>;
let storage: PersonalDocumentStorage | null = null;
export function registerPersonalDocumentStorage(value: PersonalDocumentStorage): void { storage = value; }
export function personalDocumentStorage(): PersonalDocumentStorage | null { return storage; }
