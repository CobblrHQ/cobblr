export type DocumentPrivacy = "personal" | "normal";
export type PersonalDocumentField = "vin" | "plate" | "expires" | "amount" | "reference" | "make" | "model" | "year";
export type PersonalDocumentKind = "registration" | "bill-of-sale" | "personal" | "ordinary";
/** The fields each kind of document carries: the only ones a read may call
 *  missing, or ask an AI for (#5839). A bill of sale has no plate, expiry or
 *  confirmation number, and asking a person to "check" them sends them
 *  looking for what their paper never had. A personal document of no known
 *  kind is asked for the registration's set, as before. */
export const FIELDS_FOR_KIND: Readonly<Record<PersonalDocumentKind, readonly PersonalDocumentField[]>> = {
  registration: ["vin", "plate", "expires", "amount", "reference"],
  "bill-of-sale": ["vin", "year", "make", "model"],
  personal: ["vin", "plate", "expires", "amount", "reference"],
  ordinary: [],
};
export interface PersonalDocumentRead {
  privacy: DocumentPrivacy;
  /** "bill-of-sale": a vehicle's bill of sale, which the card offers to
   *  file as the vehicle's purchase (#5331). */
  kind: PersonalDocumentKind;
  renewalType?: string;
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
  return { privacy: "personal", kind: "personal", fields: {}, sources: {}, missing: [...FIELDS_FOR_KIND.personal],
    message: "This document could not be read here. It has not been sent to a cloud AI." };
}
export type PersonalDocumentStorage = (request: { orgId: string; userId: string; input: DocumentInput; filename: string; folderId?: string }) => Promise<{ fileId: string; folderId: string }>;
let storage: PersonalDocumentStorage | null = null;
export function registerPersonalDocumentStorage(value: PersonalDocumentStorage): void { storage = value; }
export function personalDocumentStorage(): PersonalDocumentStorage | null { return storage; }

/** Shared Files refused a file because it is a personal document. Typed, so
 *  what asked can offer the supported place (the Vault) instead of showing
 *  the refusal as a dead end (#5871). */
/** Where a person reads a personal document on purpose, as every refusal
 *  says it: one phrase, so a reader that moves is renamed once (the scan
 *  inbox's "Personal documents" box moved to its ⋯ menu, 2026-10-12, and
 *  six messages still sent people to the box). */
export const PERSONAL_READER_PLACE = "Read a personal document, in the scan inbox's ⋯ menu or the Vault";

export class PersonalDocumentRefused extends Error {
  readonly code = "personal_document" as const;
  constructor(message = `This is a personal document, so it was not saved to shared Files. Read it with ${PERSONAL_READER_PLACE}.`) {
    super(message);
    this.name = "PersonalDocumentRefused";
  }
}
export function isPersonalDocumentRefused(err: unknown): err is PersonalDocumentRefused {
  return err instanceof PersonalDocumentRefused || (err as { code?: unknown } | null)?.code === "personal_document";
}
