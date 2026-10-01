// A picture's source goes on the file once, when the file is written: a
// later writer of the same bytes (the same catalog picture saved again) does
// not rename where it came from. See platform-contract/photo-source.
import { sql, type Kysely } from "kysely";
import { photoSourceOf, type PhotoSource } from "@cobblr/platform-contract/photo-source";
import type { CoreFilesDB } from "../db.js";

export async function notePhotoSource(db: Kysely<CoreFilesDB>, fileId: string, source: PhotoSource): Promise<void> {
  await db
    .updateTable("core_files_files")
    .set({ metadata: sql`metadata || ${JSON.stringify({ photo_source: source })}::jsonb` })
    .where("id", "=", fileId)
    .where(sql<boolean>`not (metadata ? 'photo_source')`)
    .execute();
}

export { photoSourceOf };
