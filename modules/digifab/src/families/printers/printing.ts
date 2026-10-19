// The printers family's side of the printing seam (core/printing.ts): the farm's
// candidates and material refusal, a finished print's material, and a Make's
// print steps.
import type { FamilyPrinting } from "../../core/printing.js";
import { gatherCandidates, loadedSpoolsForMachine } from "./api/printing-profiles.js";
import { drawForCompletedJob, planCompletedMaterial, putBackDrawn } from "./loaded-spools.js";
import { cancelBatch, reviewBatch, settleBatchForJob, startBatchPrint } from "./print-batch.js";
import { recoverPrintThis, startPrint, startPrintThis } from "./print-this.js";
import { printerMaterialRefusal } from "./printer-material.js";

export const printing: FamilyPrinting = {
  candidates: gatherCandidates,
  loadedFor: loadedSpoolsForMachine,
  materialRefusal: printerMaterialRefusal,
  planCompleted: planCompletedMaterial,
  drawCompleted: drawForCompletedJob,
  putBack: putBackDrawn,
  startPrintThis,
  startPrint,
  startBatch: startBatchPrint,
  reviewBatch,
  cancelBatch,
  settleBatchForJob,
  recover: recoverPrintThis,
};
