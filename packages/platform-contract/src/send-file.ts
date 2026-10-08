import { z } from "zod";
import { sendFileThing } from "@cobblr/platform-contract/share-offer";

export const SEND_FILE_MAX_BYTES = 64 * 1024 * 1024;
const word = z.string().min(1).max(300);
const kind = z.string().min(1).max(120);
const origin = z.object({instance: z.string().url().max(2048), org: z.string().uuid(), kind, id: z.string().uuid()});
const bytes = z.string().max(SEND_FILE_MAX_BYTES).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "A file has damaged bytes.");
const field = z.object({
  name: kind, display_label: word, type: kind, native: z.boolean().optional(),
  field_role: z.string().nullable().optional(), choices: z.array(z.string()).max(500).nullable().optional(),
  unit: z.string().nullable().optional(), money: z.enum(["cents", "amount"]).nullable().optional(),
  learns: z.boolean().nullable().optional(), required: z.boolean().optional(),
  private: z.boolean().optional(),
});
const thing = z.object({
  name: word, manufacturer: z.string().nullable().optional(), model: z.string().nullable().optional(),
  kind_words: z.string().nullable().optional(), quantity: z.number().nullable().optional(), notes: z.string().nullable().optional(),
  collection: z.object({module: kind, instance: z.string().nullable()}).nullable().optional(),
  fields: z.record(z.string()).optional(), photos: z.array(z.object({mime: kind, data: bytes})).max(0).default([]),
  send: z.object({
    version: z.literal(1), mode: z.enum(["copy", "move"]), origin,
    module_version: kind, kind_version: kind, values: z.record(z.unknown()),
    references: z.array(z.object({label: word, value: z.unknown()})).max(300).optional(),
    files: z.array(z.object({filename: word, mime: kind, data: bytes, role: z.string().nullable(), sort_order: z.number().int()})).max(1000),
    needs: z.array(z.string()).max(300).default([]),
    target_kind: z.string().nullable().default(null), mapped: z.record(z.unknown()).default({}),
    field_map: z.record(z.string().nullable()).optional(), location: z.string().nullable().default(null), placement_needed: z.boolean().optional(),
  }),
}).transform((t) => sendFileThing({...t, fields: t.fields ?? {}, send: {...t.send, references: t.send.references?.map((r) => ({label: r.label, value: r.value}))}}));

export const SendFileSchema = z.object({
  format: z.literal("cobblr-send"), version: z.literal(1), id: z.string().uuid(), created_at: z.string().datetime(),
  mode: z.enum(["copy", "move"]), confirmation_key: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.object({instance: z.string().url().max(2048), org: z.string().uuid(), name: word, person: word}),
  collection: z.object({kind, base_kind: kind, module: kind, instance: z.string().nullable(), name: word, plural: word, fields: z.array(field).max(300)}),
  items: z.array(thing).min(1).max(200),
}).superRefine((file, ctx) => {
  const ids = new Set<string>();
  for (const [i, thing] of file.items.entries()) {
    const s = thing.send!;
    if (s.origin.instance !== file.source.instance || s.origin.org !== file.source.org || s.origin.kind !== file.collection.kind || s.mode !== file.mode || ids.has(s.origin.id)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ["items", i], message: "These items do not describe one send from this workspace."});
    }
    ids.add(s.origin.id);
  }
});
export type SendFile = z.infer<typeof SendFileSchema>;
export type SendFileField = z.infer<typeof field>;

export function readSendFile(input: unknown): SendFile {
  const result = SendFileSchema.safeParse(input);
  if (!result.success) throw new Error(`Cannot read this send file. ${result.error.issues[0]?.message ?? "Download it again from the source Cobblr."}`);
  return result.data;
}

export const SendReceiptSchema = z.object({
  format: z.literal("cobblr-send-receipt"), version: z.literal(1), file_id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  source_instance: z.string().url().max(2048), source_org: z.string().uuid(), import_id: z.string().uuid(),
  target: z.object({instance: z.string().url().max(2048), org: z.string().uuid(), name: word, person: word}),
  ids: z.array(z.string().uuid()).min(1).max(200), phase: z.enum(["imported", "undone"]), signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SendReceipt = z.infer<typeof SendReceiptSchema>;

export function sendFileVersionAdvice(p: {collection: string; sourceModule: string; targetModule?: string | null; sourceKind: string; targetKind?: string | null; matching: boolean}) {
  const warnings: string[] = [];
  const blocked: string[] = [];
  const major = (v: string) => /^\d+/.test(v) ? Number(v.match(/^\d+/)![0]) : null;
  for (const [label,source,target] of [[p.collection,p.sourceModule,p.targetModule],[`${p.collection} collection`,p.sourceKind,p.targetKind]] as const) {
    if (!target || source === target) continue;
    warnings.push(`This Cobblr has ${label} ${target}; the item comes from ${source}. Fields this collection cannot take need a decision.`);
    if (p.matching && major(source) !== null && major(target) !== null && major(source)! > major(target)!) blocked.push(`This Cobblr has ${label} ${target}; the item needs ${source}. Update first, or choose another collection and map the fields it supports.`);
  }
  return {warnings,blocked};
}
