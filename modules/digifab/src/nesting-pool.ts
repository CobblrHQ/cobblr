import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
export type NestResult = { placed: number; layouts: { container_id: number; placed_items: { transformation: { rotation: number; translation: [number, number] } }[] }[]; outlines: [number, number][][][] };
type Task = { input: string; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; slot?: Slot; best?: unknown };
type Slot = { worker: Worker; task?: Task };
const slots: Slot[] = [], queue: Task[] = [];
const failure = () => new Error("The outline search reached its time budget. Try fewer parts or optimize harder.");
function drain() {
 while (queue.length) {
  let slot = slots.find(s => !s.task);
  if (!slot && slots.length < 2) {
   const entry = new URL("./nesting-worker.js", import.meta.url);
   const worker = new Worker(existsSync(entry) ? entry : new URL("./nesting-worker.ts", import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
   slot = { worker }; slots.push(slot);
   worker.on("message", (message: { result?: unknown; progress?: unknown; error?: string }) => {
    const task = slot!.task;
    if (!task) return;
    if(message.progress) { task.best=message.progress;return; }
    clearTimeout(task.timer); slot!.task = undefined; task.slot = undefined; worker.unref();
    if (message.result) task.resolve(message.result); else task.reject(new Error(message.error || "The outline search failed."));
    drain();
   });
   worker.on("error", error => retire(slot!, error));
   worker.on("exit", code => { if (slots.includes(slot!)) retire(slot!, new Error(`The outline worker stopped (${code}).`)); });
  }
  if (!slot) return;
  const task = queue.shift()!; slot.task = task; task.slot = slot;
  slot.worker.ref(); slot.worker.postMessage(task.input);
 }
}
function retire(slot: Slot, error: Error) {
 const index = slots.indexOf(slot); if (index < 0) return;
 slots.splice(index, 1);
 if (slot.task) { clearTimeout(slot.task.timer); slot.task.reject(error); slot.task = undefined; }
 void slot.worker.terminate(); drain();
}
export function runNestWorker<T>(input: unknown, budgetMs: number): Promise<T> {
 if (queue.length >= 32) return Promise.reject(new Error("The outline search is busy. Try again shortly."));
 return new Promise((resolve, reject) => {
  const task: Task = { input: JSON.stringify(input), resolve: result => resolve(result as T), reject, timer: setTimeout(() => {
   if (task.slot) {
    if(task.best) { const slot=task.slot;slot.task=undefined;task.resolve(task.best);retire(slot,failure()); }
    else retire(task.slot, failure());
   }
   else { const index = queue.indexOf(task); if (index >= 0) queue.splice(index, 1); reject(failure()); }
  }, budgetMs) };
  queue.push(task); drain();
 });
}
export function closeNestingPool() { for (const task of queue.splice(0)) { clearTimeout(task.timer); task.reject(failure()); } for (const slot of [...slots]) retire(slot, failure()); }
