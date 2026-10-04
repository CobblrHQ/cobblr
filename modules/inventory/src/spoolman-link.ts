export function sameSpoolLink(metadata: Record<string, unknown>, connection: string, spool: number): boolean {
  return metadata.spoolman_connection_id === connection && String(metadata.spoolman_id) === String(spool);
}
