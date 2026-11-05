// What a backup archive holds, read out of it (#8957).
//
// A table's rows are parsed as its bytes inflate, never gathered into one
// buffer first: a 571 MB table grew a restore by 1,286 MB (its chunks, then
// their copy, then the rows). Read this way it grows by 150 MB.
import unzipper from "unzipper";
import { zipOnDisk } from "@cobblr/platform-contract/zip-on-disk";
import type { BlueprintManifestT } from "./blueprint.js";
import type { PlatformRows } from "../platform/backup-platform-rows.js";
import { makeUncompressedBudget, readEntryBounded, readJsonlRowsBounded } from "./backup-limits.js";

export interface DataIndexTable {
  table: string;
  file: string;
  row_count: number;
}
export interface DataIndexFile {
  file_id: string;
  name: string;
  mime: string;
}

export interface ParsedBackup {
  manifest: BlueprintManifestT & {
    data_index?: { tables: DataIndexTable[]; files: DataIndexFile[]; platform?: DataIndexTable[] };
  };
  tables: Map<string, Array<Record<string, unknown>>>;
  /** Null for a backup taken before the shared tables were carried: a restore
   *  of one leaves the target's shared rows as they are rather than clearing
   *  them for nothing. */
  platform: PlatformRows | null;
  files: Map<string, Buffer>;
}

/** Reads the archive where it lies: a path (an upload, streamed to disk by the
 *  upload door) is opened in place, never read into memory whole. */
export async function parseBackupZip(src: Buffer | string): Promise<ParsedBackup> {
  if (typeof src !== "string") return parseBackupDir(await unzipper.Open.buffer(src));
  const zip = await zipOnDisk(src);
  try {
    return await parseBackupDir(await unzipper.Open.custom(zip.source));
  } finally {
    await zip.close();
  }
}

async function parseBackupDir(dir: unzipper.CentralDirectory): Promise<ParsedBackup> {
  let manifest: ParsedBackup["manifest"] | null = null;
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const shared: PlatformRows = new Map();
  const files = new Map<string, Buffer>();
  // A restore is admin-triggered but the .zip is attacker-supplyable, so a
  // decompression bomb here would OOM the shared host (audit M-BOMB). Read every
  // entry through a running uncompressed-byte budget that aborts mid-stream, so
  // a tiny .zip can never inflate past the ceiling — declared header size is
  // only a cheap pre-check; the actual streamed bytes are what's enforced.
  const budget = makeUncompressedBudget();
  type Entry = (typeof dir.files)[number];
  const limits = () => ({ maxEntryBytes: budget.maxEntryBytes, remainingTotalBytes: budget.remaining() });
  const readEntry = async (entry: Entry): Promise<Buffer> => {
    budget.precheck(entry.uncompressedSize);
    const b = await readEntryBounded(entry.stream() as AsyncIterable<Uint8Array>, limits());
    budget.charge(b.length);
    return b;
  };
  const readRows = async (entry: Entry): Promise<Array<Record<string, unknown>>> => {
    budget.precheck(entry.uncompressedSize);
    const { rows, bytes } = await readJsonlRowsBounded(entry.stream() as AsyncIterable<Uint8Array>, limits());
    budget.charge(bytes);
    return rows;
  };
  for (const entry of dir.files) {
    if (entry.type !== "File") continue;
    if (entry.path === "manifest.json") {
      manifest = JSON.parse((await readEntry(entry)).toString("utf8"));
    } else if (entry.path.startsWith("data/") && entry.path.endsWith(".jsonl")) {
      tables.set(entry.path.slice("data/".length, -".jsonl".length), await readRows(entry));
    } else if (entry.path.startsWith("platform/") && entry.path.endsWith(".jsonl")) {
      shared.set(entry.path.slice("platform/".length, -".jsonl".length), await readRows(entry));
    } else if (entry.path.startsWith("files/")) {
      files.set(entry.path.slice("files/".length), await readEntry(entry));
    }
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw Object.assign(new Error("manifest.json missing from backup, or not a manifest"), { code: "bad_archive" });
  const carriesPlatform = Array.isArray(manifest.data_index?.platform);
  return { manifest, tables, platform: carriesPlatform ? shared : null, files };
}
