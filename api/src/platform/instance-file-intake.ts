// "Each dropped file becomes a record": a table's file intake.
//
// A bundle declares it on an instance (`file_intake`): Yarn's Patterns table
// says every PDF dropped on it is a pattern, with that PDF attached as its
// pattern. The files themselves arrive through core-files' one intake (the
// Files page's door: plain files or a zip, deduped by their bytes), which
// answers a line per file. This takes those lines and makes the records.
//
// Kind-agnostic on purpose. The record is made through the kind's own create
// endpoint, as the person (the same door carry-replay uses), its title field
// found by role, and the file attached through platform().files. Nothing here
// names a module.
//
// What would be expensive, and so is held here:
//   - a second record for a file a record already owns (a re-import, a zip
//     holding patterns imported before): platform().files.attachmentsOfFile
//     is asked first, and the owner is answered instead;
//   - a file moved out of the folder the person keeps it in: a duplicate line
//     is linked where it is, never moved;
//   - a stray key in a record's custom fields: only a declared choice lands
//     in the folder field, matched to the choice's own spelling.
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { signSession } from "../auth/jwt.js";
import { listKindsForOrg } from "./entities.js";
import { platform, type EntityKindRecord, type FileIntakeDecl } from "@cobblr/platform-contract";

export type { FileIntakeDecl };

/** One line of core-files' intake answer, as the web hands it on. */
export interface IntakeLineIn {
  status: string;
  filename: string;
  path?: string;
  file_id?: string;
  mime_type?: string;
}

export interface IntakeOutcome {
  filename: string;
  path: string;
  /** created: a new record owns the file. existing: a record already did.
   *  skipped: not a file for this table (or not stored). failed: see reason. */
  outcome: "created" | "existing" | "skipped" | "failed";
  record_id?: string;
  title?: string;
  reason?: string;
}

/** A record's title from its file's name: "granny_square-blanket_v2.pdf" →
 *  "granny square blanket v2". The name is what the person saved it as. */
export function titleFromFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const t = base
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/(?<=\S)-(?=\S)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t || base;
}

/** The choice a zip's top folder names, in the choice's own spelling, or null. */
export function choiceFromPath(path: string | undefined, choices: readonly string[]): string | null {
  if (!path || !path.includes("/")) return null;
  const top = path.split("/")[0]!.trim().toLowerCase();
  return choices.find((c) => c.trim().toLowerCase() === top) ?? null;
}

function kindForInstance(kinds: EntityKindRecord[], instance: string): EntityKindRecord | null {
  return kinds.find((k) => k.instance_name === instance && (k.endpoints?.create ?? null) !== null) ?? null;
}

/** Make a record for every file line that is this table's, and link a file a
 *  record already owns to that record. */
export async function intakeFiles(opts: {
  orgId: string;
  slug: string;
  userId: string;
  instance: string;
  decl: FileIntakeDecl;
  lines: IntakeLineIn[];
  /** Answers to `ask`, for the whole batch. Only asked fields are taken. */
  values?: Record<string, string>;
}): Promise<IntakeOutcome[]> {
  const { orgId, slug, instance, decl } = opts;
  const k = kindForInstance(await listKindsForOrg(orgId), instance);
  if (!k) throw Object.assign(new Error("This table cannot make records from files."), { code: "no_create" });
  // An instance kind ("designs:item") attaches under its module's primary type
  // (projects/project), the way the record's own files panel reads them.
  const sourceType = k.instance_name ? await baseTypeOf(orgId, k) : (k.id.split(":")[1] ?? "item");
  const titleField = (k.fields ?? []).find((f) => f.role === "title")?.name ?? "name";

  // The folder field's choices, from the table's own field definition.
  let folderChoices: string[] = [];
  if (decl.folder_field) {
    const def = await meta
      .selectFrom("module_field_defs")
      .select(["choices"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", k.id)
      .where("name", "=", decl.folder_field)
      .executeTakeFirst();
    const c = (def as { choices?: unknown } | undefined)?.choices;
    folderChoices = Array.isArray(c) ? c.filter((x): x is string => typeof x === "string") : [];
  }
  const asked = new Set(decl.ask ?? []);
  const values: Record<string, string> = {};
  for (const [key, v] of Object.entries(opts.values ?? {})) if (asked.has(key) && typeof v === "string" && v.trim()) values[key] = v.trim();

  const session = await signSession(opts.userId);
  // loopback-ok: #5153 moves this onto selfFetch
  const base = `http://127.0.0.1:${env.API_PORT}/api/v1/orgs/${encodeURIComponent(slug)}/instances/${encodeURIComponent(instance)}`;
  const out: IntakeOutcome[] = [];
  // One file, one record, within a batch too: the same bytes twice in one zip
  // answer as the one file, and must not make two records.
  const madeFor = new Map<string, string>();

  for (const line of opts.lines) {
    const path = line.path || line.filename;
    const said = (o: Omit<IntakeOutcome, "filename" | "path">): void => void out.push({ filename: line.filename, path, ...o });
    if ((line.status !== "stored" && line.status !== "duplicate") || !line.file_id) {
      said({ outcome: "skipped", reason: line.status === "too_big" ? "too big to store" : `not stored (${line.status})` });
      continue;
    }
    if (!decl.accept.includes((line.mime_type ?? "").toLowerCase())) {
      said({ outcome: "skipped", reason: "kept in Files, but not a file this table makes records from" });
      continue;
    }
    try {
      const already = madeFor.get(line.file_id);
      if (already) {
        said({ outcome: "existing", record_id: already });
        continue;
      }
      const owners = (await platform().files.attachmentsOfFile(orgId, line.file_id)) ?? [];
      const owner = owners.find((a) => a.role === decl.role && a.source_module === k.module_name && a.source_type === sourceType);
      if (owner) {
        madeFor.set(line.file_id, owner.source_id);
        said({ outcome: "existing", record_id: owner.source_id });
        continue;
      }
      const title = titleFromFilename(line.filename);
      const metadata: Record<string, string> = { ...values };
      const fromFolder = decl.folder_field ? choiceFromPath(line.path, folderChoices) : null;
      if (decl.folder_field && fromFolder) metadata[decl.folder_field] = fromFolder;
      const res = await fetch(`${base}${k.endpoints!.create}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ [titleField]: title, ...(Object.keys(metadata).length ? { metadata } : {}) }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        said({ outcome: "failed", reason: err?.error?.message ?? `could not make it (HTTP ${res.status})` });
        continue;
      }
      const made = (await res.json()) as { id?: string; item?: { id?: string } };
      const id = made.id ?? made.item?.id;
      if (!id) {
        said({ outcome: "failed", reason: "made, but the table did not say which record" });
        continue;
      }
      await platform().files.attach(orgId, { fileId: line.file_id, source_module: k.module_name, source_type: sourceType, source_id: id, role: decl.role });
      madeFor.set(line.file_id, id);
      said({ outcome: "created", record_id: id, title });
    } catch (err) {
      said({ outcome: "failed", reason: (err as Error).message });
    }
  }
  return out;
}

/** The entity type a kind's records are attached under (projects:project →
 *  "project"), for an instance kind whose id is the instance's own. */
async function baseTypeOf(orgId: string, k: EntityKindRecord): Promise<string> {
  const kinds = await listKindsForOrg(orgId);
  const baseKind = kinds.find((b) => b.module_name === k.module_name && !b.instance_name && b.is_primary);
  return baseKind ? baseKind.id.split(":")[1] ?? "item" : "item";
}
