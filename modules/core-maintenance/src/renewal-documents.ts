import { platform, type EntityViewer } from "@cobblr/platform-contract";
import type { PersonalDocumentField } from "@cobblr/platform-contract/personal-documents";

import { renewalDocumentTypes, type RenewalDocumentType } from "@cobblr/platform-contract/renewal-document-types";
export { renewalDocumentTypes } from "@cobblr/platform-contract/renewal-document-types";

export type RenewalDocumentFields = Partial<Record<PersonalDocumentField, string>>;
export interface RenewalDocumentCandidate {
  kind: string;
  id: string;
  title: string;
  expiry: string | null;
  values: RenewalDocumentFields;
}
const text = (value: unknown) => value == null ? "" : String(value).trim().toLowerCase();
const identifier = (value: unknown) => text(value).replace(/[^a-z0-9]/g, "");
export function matchingRenewalRecords(type: RenewalDocumentType, fields: RenewalDocumentFields, records: readonly RenewalDocumentCandidate[]): RenewalDocumentCandidate[] {
  for (const field of type.identifiers) {
    const value = identifier(fields[field.document]);
    if (!value) continue;
    const matches = records.filter(record => identifier(record.values[field.document]) === value);
    if (matches.length) return matches;
  }
  if (!type.description.length || type.description.some(field => !text(fields[field.document]))) return [];
  return records.filter(record => type.description.every(field => text(record.values[field.document]) === text(fields[field.document])));
}
export async function planRenewalDocument(orgId: string, viewer: EntityViewer, documentType: string, fields: RenewalDocumentFields) {
  const type = renewalDocumentTypes.find(t => t.id === documentType);
  if (!type) throw new Error("Choose a renewal document type.");
  const records: RenewalDocumentCandidate[] = [];
  const collections: Array<{ kind: string; label: string; fields: Record<string, { name: string; type: string; native: boolean }>; titleField: string }> = [];
  let complete = true;
  for (const kind of await platform().entities.listKindsForOrg(orgId)) {
    const defs = await platform().entities.fieldsFor(orgId, kind.id);
    if (!defs.some(field => field.name === type.expiryField && field.type === "date")) continue;
    const hidden = await platform().entities.hiddenFields(orgId, kind.id, viewer);
    if (hidden.has(type.expiryField)) continue;
    const fieldMap: Record<string, { name: string; type: string; native: boolean }> = {};
    for (const field of [...type.identifiers, ...type.description]) {
      const name = (field.role && kind.fields.find(f => f.decodeRole === field.role)?.name) || field.record;
      const nativeField = kind.fields.find(f => f.name === name);
      const definition = defs.find(f => f.name === name) ?? nativeField;
      if (definition && !hidden.has(name)) fieldMap[field.document] = { name, type: definition.type, native: !!nativeField };
    }
    fieldMap.expires = { name: type.expiryField, type: "date", native: defs.find(f => f.name === type.expiryField)?.native === true };
    const titleField = kind.fields.find(f => f.role === "title")?.name || "name";
    collections.push({ kind: kind.id, label: kind.display_name_plural || kind.display_name, fields: fieldMap, titleField });
    const result = await platform().entities.listAll(orgId, kind.id, {}, viewer);
    complete &&= result.complete;
    for (const record of result.items) {
      const metadata = record.fields.metadata && typeof record.fields.metadata === "object" ? record.fields.metadata as Record<string, unknown> : {};
      const values: RenewalDocumentFields = {};
      for (const field of [...type.identifiers, ...type.description]) {
        const name = (field.role && kind.fields.find(f => f.decodeRole === field.role)?.name) || field.record;
        const value = record.fields[name] ?? metadata[name];
        if (value != null && !hidden.has(name)) values[field.document] = String(value);
      }
      const expiry = record.fields[type.expiryField] ?? metadata[type.expiryField];
      records.push({ kind: kind.id, id: record.id, title: record.title, expiry: typeof expiry === "string" ? expiry.slice(0, 10) : null, values });
    }
  }
  const candidates = matchingRenewalRecords(type, fields, records);
  return { type, candidates, records, collections, complete, matched: complete && candidates.length === 1 ? { kind: candidates[0]!.kind, id: candidates[0]!.id } : null };
}
