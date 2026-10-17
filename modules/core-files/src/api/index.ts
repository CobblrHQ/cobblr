// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-files/
// by the platform, with requireAuth + withTenant already applied.
//
// Side effects on import: registers the file entity resolver so
// platform.entities.lookup("core-files:file", id) works.

import { Router } from "express";
import { attachmentsRouter } from "./attachments.js";
import { filesRouter } from "./files.js";
import { foldersRouter } from "./folders.js";
import { importZipRouter } from "./import-zip.js";
import { registerFileResolvers } from "./resolvers.js";
import { registerAttachmentsOfFile } from "./attachments-of-file.js";
import { registerFolders } from "./folders-seam.js";
import { registerAttachFileAction } from "./attach-file-action.js";
import { registerDetachFileAction } from "./detach-file-action.js";

registerAttachFileAction();
registerDetachFileAction();

registerFileResolvers();

registerAttachmentsOfFile();

registerFolders();

const router = Router({ mergeParams: true });

// Before /files, so "import-zip" is never read as a file id.
router.use("/files/import-zip", importZipRouter);
router.use("/files", filesRouter);
router.use("/attachments", attachmentsRouter);
router.use("/folders", foldersRouter);

export default router;
