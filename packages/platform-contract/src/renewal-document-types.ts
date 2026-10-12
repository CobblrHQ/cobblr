import type { PersonalDocumentField } from "@cobblr/platform-contract/personal-documents";

export interface RenewalDocumentType {
  id: string;
  label: string;
  words: readonly string[];
  expiryField: string;
  folder: string;
  recordLabel: string;
  identifiers: ReadonlyArray<{ document: PersonalDocumentField; record: string; role?: string }>;
  description: ReadonlyArray<{ document: PersonalDocumentField; record: string; role?: string }>;
}
const vehicleIdentity = [
  { document: "vin", record: "serial_number", role: "identifier:vin" },
  { document: "plate", record: "license_plate" },
] as const;
const vehicleDescription = [
  { document: "make", record: "manufacturer", role: "decode:make" },
  { document: "model", record: "model", role: "decode:model" },
  { document: "year", record: "year", role: "decode:year" },
] as const;
export const renewalDocumentTypes: readonly RenewalDocumentType[] = [
  { id: "registration", label: "Registration", words: ["vehicle registration", "registration renewal"], expiryField: "registration_expires", folder: "Car documents", recordLabel: "car", identifiers: vehicleIdentity, description: vehicleDescription },
  { id: "inspection", label: "Inspection", words: ["vehicle inspection", "inspection certificate"], expiryField: "inspection_expires", folder: "Car documents", recordLabel: "car", identifiers: vehicleIdentity, description: vehicleDescription },
  { id: "insurance", label: "Insurance", words: ["insurance renewal", "insurance policy"], expiryField: "insurance_expires", folder: "Car documents", recordLabel: "car", identifiers: vehicleIdentity, description: vehicleDescription },
  { id: "licence", label: "Licence", words: ["driver licence", "driver's licence"], expiryField: "licence_expires", folder: "Personal documents", recordLabel: "record", identifiers: [{ document: "reference", record: "licence_number" }], description: [] },
  { id: "passport", label: "Passport", words: ["passport renewal", "passport"], expiryField: "passport_expires", folder: "Personal documents", recordLabel: "record", identifiers: [{ document: "reference", record: "passport_number" }], description: [] },
];

export function renewalDocumentTypeIn(text: string): RenewalDocumentType | null {
  const words = text.toLowerCase().replace(/\s+/g, " ");
  return renewalDocumentTypes.find(type => type.words.some(word => words.includes(word))) ?? null;
}
