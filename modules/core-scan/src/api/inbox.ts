// The scan inbox's HTTP routes: this file only mounts them. Each group of
// routes is a file of its own under ./inbox/ (#7385), and what more than one
// group uses is ./inbox/shared.ts.
import { Router } from "express";
import { queueRouter } from "./inbox/queue.js";
import { intakeRouter } from "./inbox/intake.js";
import { resolveRouter } from "./inbox/resolve.js";
import { receiptsRouter } from "./inbox/receipts.js";
import { listRouter } from "./inbox/list.js";
import { confirmRouter } from "./inbox/confirm.js";
import { discardRouter } from "./inbox/discard.js";
import { rerunRouter } from "./inbox/rerun.js";
import { attachRouter } from "./inbox/attach.js";
import { photosRouter } from "./inbox/photos.js";
import { bulkRouter } from "./inbox/bulk.js";
import { combineRouter } from "./inbox/combine.js";
import { batchesRouter } from "./inbox/batches.js";

export { INTERNAL_API, runBounded, storedCandidateList } from "./inbox/shared.js";
export { fileReceiptRead } from "./inbox/receipts.js";
export { PatchBody, servedAll } from "./inbox/list.js";
export { ConfirmBody } from "./inbox/confirm.js";
export { filingKindFor, servedItemName } from "./inbox/discard.js";
export { preRerunRestore } from "./inbox/rerun.js";

// The scan inbox's routes, one file per group under ./inbox/ (#7385). Mounted
// in the order they were written, so a literal path still answers before a
// parameter one; a new route goes in its group's file, or a new group's.
export const inboxRouter = Router({ mergeParams: true });
inboxRouter.use(queueRouter);
inboxRouter.use(intakeRouter);
inboxRouter.use(resolveRouter);
inboxRouter.use(receiptsRouter);
inboxRouter.use(listRouter);
inboxRouter.use(confirmRouter);
inboxRouter.use(discardRouter);
inboxRouter.use(rerunRouter);
inboxRouter.use(attachRouter);
inboxRouter.use(photosRouter);
inboxRouter.use(bulkRouter);
inboxRouter.use(combineRouter);
inboxRouter.use(batchesRouter);
