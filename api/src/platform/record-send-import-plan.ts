import { platform, type DefinedField } from "@cobblr/platform-contract";
import { mapOfferedFields, sendFileThing } from "@cobblr/platform-contract/share-offer";
import { sendFileVersionAdvice, type SendFile } from "@cobblr/platform-contract/send-file";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { listKindsForOrg, lookup } from "./entities.js";
import { hiddenFieldsFor } from "./field-scope-projection.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { getInstance, provisionInstance } from "./instances.js";
import { createFieldDef, FieldDefCreate } from "./field-defs.js";
import { SendError, sendMembership, requireSendToken, mayCreateSend, sendFieldDefs, findSendArrival, type SendItemPreview } from "./record-send.js";

export interface IncomingSendFileRequest {
  packet: SendFile; collection?: string | null; field_map?: Record<string, string | null>;
  create_matching?: boolean; add_fields?: string[]; placement?: "unplaced"; location?: string | null;
  duplicate?: "update" | "another"; request_id?: string; dry_run?: boolean;
}

export async function prepareSendFileImport(orgId: string, userId: string, p: IncomingSendFileRequest) {
  await requireSendToken();
  const target = await sendMembership(orgId, userId);
  if (!roleSatisfies(target.role, ["member"])) throw new SendError("You can only import into a workspace where you can create records.");
  const kinds = await listKindsForOrg(orgId);
  const source = p.packet.collection;
  const match = p.collection ? kinds.find((k) => k.id === p.collection) : kinds.find((k) => k.id === source.kind && k.module_name === source.module) ?? kinds.find((k) => k.module_name === source.module && k.display_name === source.name);
  if (p.collection && !match) throw new SendError("That collection is not enabled in this workspace.");
  if (match && !await mayCreateSend(orgId, userId, target.role, match.module_name)) throw new SendError("You cannot create records in that collection.");
  const canConfigure = roleSatisfies(target.role, ["admin"]);
  if ((p.create_matching || p.add_fields?.length) && !canConfigure) throw new SendError("An owner or admin can create the matching collection or add fields here.");
  if (p.location && !await lookup(orgId, "core-locations:location", p.location, {userId, role: target.role})) throw new SendError("Choose a location in this workspace.");
  const hidden = await hiddenFieldsFor(orgId, userId, target.role);
  const defs = match ? (await sendFieldDefs(orgId, match.id)).filter((d) => !hidden.has(d.name)) : [];
  const virtual: DefinedField[] = [...defs];
  if (!match && p.create_matching) virtual.push(...source.fields);
  for (const label of p.add_fields ?? []) {
    const d = source.fields.find((d) => d.display_label === label);
    if (!d || ["secret", "computed"].includes(d.type)) throw new SendError(`The ${label} field needs configuring in the receiving workspace first.`);
    if (!virtual.some((v) => v.name === d.name)) virtual.push({...d, native: false});
  }
  const module = await meta.selectFrom("org_modules").select("version").where("org_id", "=", orgId).where("module_name", "=", match?.module_name ?? source.module).executeTakeFirst();
  const blocked: string[] = [];
  const versionWarnings: string[] = [];
  const things = [];
  for (const original of p.packet.items) {
    const thing = sendFileThing(original);
    const s = thing.send!;
    s.values = {...s.values};
    for (const ref of s.references ?? []) {
      const ids = Array.isArray(ref.value) ? ref.value : [ref.value];
      const replacements: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string") break;
        const previous = await findSendArrival(orgId, {instance: s.origin.instance, org: s.origin.org, id}, {userId, role: target.role});
        const landed = previous?.landed as {inbox_id?: string} | null;
        const state = landed?.inbox_id ? await platform().scan.offerIntake()?.state(orgId, landed.inbox_id) : null;
        if (state?.status !== "filed" || !state.record) break;
        replacements.push(state.record.id);
      }
      if (replacements.length === ids.length) s.values[ref.label] = Array.isArray(ref.value) ? replacements : replacements[0];
      else s.needs.push(`${ref.label}: link not sent because the linked record is not in this workspace`);
    }
    if (source.fields.some((d) => d.type === "secret" && Object.hasOwn(s.values, d.display_label)) || virtual.some((d) => d.type === "secret" && Object.hasOwn(s.values, d.display_label))) throw new SendError("Secret fields need the encrypted reveal service before they can travel.");
    const mapped = mapOfferedFields(s.values, virtual, p.field_map);
    const collection = match?.display_name_plural || match?.display_name || (p.create_matching ? source.plural : null);
    const needs = [...(match || p.create_matching ? [] : ["Choose or create a matching collection"]), ...mapped.missing.map((f) => `${f} has no field in ${collection ?? "the target collection"}`)];
    if (s.placement_needed && !p.location && p.placement !== "unplaced") needs.push("Choose a placement in this workspace");
    s.target_kind = match?.id ?? (p.create_matching ? source.kind : null);
    s.mapped = mapped.values; s.field_map = p.field_map; s.location = p.location ?? null;
    s.needs = [...s.needs, ...needs];
    const previous = await findSendArrival(orgId, s.origin, {userId, role: target.role});
    const preview: SendItemPreview = {id: s.origin.id, name: thing.name, collection, mappings: mapped.mappings, missing: mapped.missing, dropped: [...mapped.dropped, ...s.needs.filter((n) => !needs.includes(n))], needs, duplicate: previous?.id ?? null, files: s.files.length, arrival: needs.length ? "inbox" : "collection"};
    if (match?.module_name === source.module) {
      const advice = sendFileVersionAdvice({collection: source.plural,sourceModule: s.module_version,targetModule: module?.version,sourceKind: s.kind_version,targetKind: match.version,matching: !p.collection || match.id === source.kind});
      versionWarnings.push(...advice.warnings); blocked.push(...advice.blocked);
    }
    things.push({thing, preview});
  }
  const room = platform().scan.offerIntake()?.room;
  if (room) blocked.push(...await room(orgId, {userId, orgSlug: target.slug}, {count: things.filter((i) => !(i.preview.duplicate && p.duplicate === "update")).length, bytes: things.reduce((n, i) => n + i.thing.send!.files.reduce((s, f) => s + Buffer.byteLength(f.data, "base64"), 0), 0)}));
  const collections = [];
  for (const k of kinds) if (await mayCreateSend(orgId, userId, target.role, k.module_name)) collections.push({kind: k.id, label: k.display_name_plural || k.display_name, module: k.module_name});
  return {target, things, blocked: [...new Set(blocked)], versionWarnings: [...new Set(versionWarnings)], collections, canConfigure};
}

export async function previewSendFileImport(orgId: string, userId: string, p: IncomingSendFileRequest) {
  const plan = await prepareSendFileImport(orgId, userId, p);
  return {target: plan.target, blocked: plan.blocked, items: plan.things.map((i) => i.preview), can_include_secrets: false, can_configure: plan.canConfigure, collections: plan.collections, version_warnings: plan.versionWarnings};
}

export async function prepareImportedCollection(orgId: string, userId: string, p: IncomingSendFileRequest) {
  if (!p.create_matching && !p.add_fields?.length) return;
  const plan = await prepareSendFileImport(orgId, userId, p);
  if (!plan.canConfigure) throw new SendError("You cannot change this collection's fields.");
  const source = p.packet.collection;
  const match = plan.things[0]?.thing.send?.target_kind;
  if (p.create_matching && !plan.things[0]?.preview.collection) throw new SendError("Choose a collection first.");
  if (p.create_matching && !(await listKindsForOrg(orgId)).some((k) => k.id === match)) {
    await enableModuleForOrg(orgId, source.module, {userId});
    if (source.instance && !await getInstance(orgId, source.instance)) {
      const made = await provisionInstance({orgId, moduleName: source.module, instanceName: source.instance, displayName: source.name});
      if (!made.ok) throw new SendError(made.message);
    }
  }
  const kind = p.collection || match || source.kind;
  const existing = await sendFieldDefs(orgId, kind);
  for (const d of source.fields) {
    if (["secret", "computed"].includes(d.type) || existing.some((e) => e.name === d.name) || (!p.create_matching && !p.add_fields?.includes(d.display_label))) continue;
    const parsed = FieldDefCreate.safeParse({...d, native: false, entity_kind: kind, required: false});
    if (!parsed.success) throw new SendError(`The ${d.display_label} field needs configuring here first.`);
    const made = await createFieldDef(orgId, parsed.data);
    if (!made.ok) throw new SendError(made.message);
  }
}
