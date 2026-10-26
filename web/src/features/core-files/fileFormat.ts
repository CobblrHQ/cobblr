// Shared by the Files list and a file's own page: how a file's size and its
// folder's path read.
import type { FileFolder } from "../../lib/api";

/** Each folder's path from the top, for breadcrumbs and "Move to…". */
export function folderPaths(folders: readonly FileFolder[]): Map<string, FileFolder[]> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, FileFolder[]>();
  for (const f of folders) {
    const path: FileFolder[] = [];
    let cur: FileFolder | undefined = f;
    for (let guard = 0; cur && guard < 64; guard++) {
      path.unshift(cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(f.id, path);
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function deleteFileMessage(filename: string): string {
  return `${filename} goes to Recently deleted for 30 days. It will disappear from any records using it until you restore it.`;
}
