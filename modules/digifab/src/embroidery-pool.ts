import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import type { EmbroideryWork } from "./embroidery-worker.js";
import type {
  EmbroideryDesign,
  EmbroiderySummary,
} from "./embroidery-design.js";
import { ReviewRequired } from "./drivers/job-review.js";
let active = 0;
export function embroideryWork(task: EmbroideryWork): Promise<{
  bytes: Uint8Array;
  design: EmbroideryDesign;
  summary: EmbroiderySummary;
}> {
  if (
    task.operation === "decode" &&
    (task.bytes.length === 0 || task.bytes.length > 2 * 1024 * 1024)
  )
    return Promise.reject(
      new ReviewRequired("Choose an embroidery file smaller than 2 MB."),
    );
  if (active >= 2)
    return Promise.reject(
      new ReviewRequired("Embroidery conversion is busy. Try again shortly."),
    );
  active++;
  return new Promise((resolve, reject) => {
    const js = new URL("./embroidery-worker.js", import.meta.url),
      compiled = existsSync(js);
    const worker = new Worker(
      compiled ? js : new URL("./embroidery-worker.ts", import.meta.url),
      {
        execArgv: compiled ? [] : ["--import", "tsx"],
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    );
    let settled = false;
    const finish = (
      error?: Error,
      result?: Awaited<ReturnType<typeof embroideryWork>>,
    ) => {
      if (settled) return;
      settled = true;
      active--;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new ReviewRequired(error.message));
      else resolve(result!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error("This embroidery file exceeded the conversion time limit."),
        ),
      5000,
    );
    worker.once(
      "message",
      (message: {
        error?: string;
        result?: Awaited<ReturnType<typeof embroideryWork>>;
      }) =>
        message.result
          ? finish(undefined, message.result)
          : finish(
              new Error(
                message.error || "The embroidery file could not be read.",
              ),
            ),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", () =>
      finish(new Error("The embroidery converter stopped.")),
    );
    worker.postMessage(task);
  });
}
