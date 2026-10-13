interface AttachPhotoRow {
  catalog_image_file_id?: string | null;
  image_file_id?: string | null;
  suggested_metadata?: unknown;
}

export function attachPhotoFileId(row: AttachPhotoRow, mode: string, imagePath: unknown): string | null {
  const chosenId =
    (row.suggested_metadata as { catalog_image_user_set?: boolean } | null)?.catalog_image_user_set &&
    row.catalog_image_file_id
      ? row.catalog_image_file_id
      : null;
  // A count answers stock; only a separate picture choice authorizes its photo.
  if (mode === "count") return chosenId;
  if ((mode === "add-qty" || mode === "replace") && (chosenId || !imagePath)) {
    return chosenId ?? row.catalog_image_file_id ?? row.image_file_id ?? null;
  }
  return null;
}
