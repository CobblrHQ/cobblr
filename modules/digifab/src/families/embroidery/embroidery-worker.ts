import { parentPort } from "node:worker_threads";
import {
  decodeEmbroidery,
  encodeEmbroidery,
  summariseEmbroidery,
  type EmbroideryDesign,
  type EmbroideryFormat,
} from "./embroidery-design.js";
export type EmbroideryWork =
  | {
      operation: "decode";
      bytes: Uint8Array;
      format: EmbroideryFormat;
    }
  | {
      operation: "encode";
      design: EmbroideryDesign;
      format: EmbroideryFormat;
      colours: Record<string, string>;
    };
parentPort?.on("message", (task: EmbroideryWork) => {
  try {
    const bytes =
      task.operation === "encode"
        ? encodeEmbroidery(task.design, task.format, task.colours)
        : task.bytes;
    const design = decodeEmbroidery(bytes, task.format);
    parentPort!.postMessage({
      result: { bytes, design, summary: summariseEmbroidery(design) },
    });
  } catch (error) {
    parentPort!.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "This embroidery file could not be read.",
    });
  }
});
